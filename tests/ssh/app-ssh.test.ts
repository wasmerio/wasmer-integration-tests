import path from "node:path";
import { TestEnv, wasmopticonDir } from "../../src";
import {
  AppCapabilities,
  AppDefinition,
  randomAppName,
  SshCapability,
  writeAppDefinition,
} from "../../src/app/construct";
import { copyPackageAnonymous } from "../../src/package";
import { generateNeedlesslySecureRandomPassword } from "../../src/security";

/**
 *
 * Plan:
 - Cover connectivity, auth, exec, sftp, isolation, lifecycle.
 - Use both programmatic (ssh2) and native ssh e2e (child_process).
 - Add retries and timeouts for cold starts and ephemeral failures.
 - Isolate known_hosts and config per test run.
 - Randomize users/passwords per deployment.
 - Log diagnostics when failing; keep output redacted.
 
 Node libs:
 - ssh2 (client) for exec and sftp channels.
 - ssh2-sftp-client for higher-level sftp ops.
 - execa for subprocess ssh/scp/sftp with timeouts.
 - tcp-port-used or wait-on to await port readiness.
 
 Native ssh usage:
 - ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=<tmp>
 - scp/sftp for file transfer e2e parity with users.
 - Use -F <tmp_config> to override defaults per test.
 - Capture exit codes/stdout/stderr with execa.
 
 Test cases:
 - Connect with valid password; whoami; printenv; pwd.
 - Wrong password denied; error includes "Permission denied".
 - Exec non-interactive command; assert exit code/stdout/stderr.
 - SFTP: upload, list, download, integrity check, delete.
 - File perms in mounted volume; persistence across redeploy.
 - Working dir confinement; cannot escape expected root.
 - Multiple users: separate homes/permissions.
 - Host key: stable across restarts or spec-compliant rotation.
 - Idle timeout disconnect behavior; active keepalive ok.
 - Rate limiting/backoff after repeated failed logins (if enabled).
 - Channel close on app purge/redeploy; reconnect succeeds.
 - Large stdout/stderr streaming; no truncation.
 - PTY interactive smoke: run tty, basic input/output.
 
 Setup/teardown:
 - Deploy app with ssh_server and generated users/passwords.
 - Wait until TCP port responds before attempting auth.
 - Create temp ssh config and known_hosts per test file.
 - After tests, purge instances and delete temp dirs.
 
 Jest scaffolding:
 - jest.setTimeout(120_000) for slow CI.
 - Use describe.each to vary users/auth methods.
 - Use beforeAll to deploy; afterAll to cleanup.
 - Wrap connect with retry (e.g., 5x, 2s backoff).
 
 ssh2 exec example:
 - import { Client } from "ssh2";
 - const conn = new Client();
 - await new Promise((res, rej) => {
 -   conn.on("ready", res)
 -       .on("error", rej)
 -       .connect({ host, port: 22, username, password });
 - });
 - const execRes = await new Promise((res, rej) => {
 -   conn.exec("echo ok && exit 0", (err, stream) => {
 -     if (err) return rej(err);
 -     let out = "", errOut = "", code = -1;
 -     stream.on("close", (c) => { code = c; res({ out, errOut, code }); })
 -           .on("data", (d) => (out += d.toString()))
 -           .stderr.on("data", (d) => (errOut += d.toString()));
 -   });
 - });
 - expect(execRes.code).toBe(0);
 - expect(execRes.out.trim()).toBe("ok");
 - conn.end();
 
 ssh2-sftp example:
 - const sftp = await new Promise((res, rej) =>
 -   conn.sftp((e, s) => (e ? rej(e) : res(s))));
 - await new Promise((res, rej) =>
 -   sftp.writeFile("/data/test.txt", Buffer.from("abc"), (e) =>
 -     e ? rej(e) : res(null)));
 - const buf = await new Promise((res, rej) =>
 -   sftp.readFile("/data/test.txt", (e, b) => (e ? rej(e) : res(b))));
 - expect(buf.toString()).toBe("abc");
 
 OpenSSH exec example:
 - const { execa } = await import("execa");
 - const sshArgs = [
 -   "-o", "StrictHostKeyChecking=no",
 -   "-o", `UserKnownHostsFile=${knownHosts}`,
 -   `${username}@${host}`, "--", "uname -a"
 - ];
 - const r = await execa("ssh", sshArgs, { timeout: 20000 });
 - expect(r.exitCode).toBe(0);
 - expect(r.stdout).toMatch(/Linux|Darwin|WSL/);
 
 OpenSSH sftp example:
 - await execa("ssh", [
 -   "-o", "StrictHostKeyChecking=no",
 -   "-o", `UserKnownHostsFile=${knownHosts}`,
 -   `${username}@${host}`, "--",
 -   "sh", "-lc", "printf abc > /data/test2.txt"
 - ]);
 - const r2 = await execa("ssh", [
 -   "-o", "StrictHostKeyChecking=no",
 -   "-o", `UserKnownHostsFile=${knownHosts}`,
 -   `${username}@${host}`, "--",
 -   "cat", "/data/test2.txt"
 - ]);
 - expect(r2.stdout).toBe("abc");
 
 Readiness helper:
 - async function waitForSsh(host, port = 22, tries = 20, ms = 2000) {
 -   for (let i = 0; i < tries; i++) {
 -     try {
 -       await execa("sh", ["-lc", `</dev/tcp/${host}/${port}`], {
 -         timeout: 3000
 -       });
 -       return;
 -     } catch {}
 -     await new Promise(r => setTimeout(r, ms));
 -   }
 -   throw new Error("SSH not ready");
 - }
 
 CI considerations:
 - Mark test suite as e2e; run in nightly or gated CI job.
 - Mask passwords in logs; redact ssh command lines.
 - Parallelize by namespace isolation; avoid port collisions.

 */

const setupApp = async (env: TestEnv) => {
  const rootPackageDir = path.join(
    await wasmopticonDir(),
    "php/php-testserver",
  );
  const dir = await copyPackageAnonymous(rootPackageDir);

  const definition: AppDefinition = {
    appYaml: {
      kind: "wasmer.io/App.v0",
      name: randomAppName(),
      owner: env.namespace,
      package: ".",
      // Enable debug mode to allow instance purging.
      debug: true,
      volumes: [
        {
          name: "data",
          mount: "/data",
        },
      ],
    },
  };
  writeAppDefinition(dir, definition);
  const info = await env.deployAppDir(dir);
  return { info, dir, definition };
};

test("app-ssh", async () => {
  const env = TestEnv.fromEnv();
  const { info, dir, definition } = await setupApp(env);

  const permalinkID = await env.getAppPermalinkID(info.id);
  const sshUsername = `${permalinkID}_`;
  const password = generateNeedlesslySecureRandomPassword(8);
  definition.appYaml.capabilities = AppCapabilities.parse({});
  definition.appYaml.capabilities.ssh_server = SshCapability.parse({
    enabled: true,
    users: [
      {
        // Backend will whine at us if this isn't set to permalinkID (or with permalinkID as suffix)
        // This is due to difficulties in resolving the app in any other way
        // SSH protocol lacks any similar lookup capacities (and no, it can't be resolved via dns)
        // See: https://wasmerio.slack.com/archives/C06S6UTABQS/p1756276006865529 for details
        username: sshUsername,
        passwords: [
          {
            password: password,
            type: "plain",
          },
        ],
      },
    ],
  });
  writeAppDefinition(dir, definition);

  const sshDeployment = await env.deployAppDir(dir);
  console.info(sshDeployment);
  const hostname = new URL(sshDeployment.url).host;
  const sshURI = `${sshUsername}:${password}@${hostname}`;
});
