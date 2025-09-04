import path from "node:path";
import { sleep, TestEnv, wasmopticonDir } from "../../src";
import {
  AppCapabilities,
  AppDefinition,
  randomAppName,
  SshCapability,
  writeAppDefinition,
} from "../../src/app/construct";
import { copyPackageAnonymous } from "../../src/package";
import { generateNeedlesslySecureRandomPassword } from "../../src/security";
import { Client } from "ssh2";
import SftpClient from "ssh2-sftp-client";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

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
  const permalinkID = await env.getAppPermalinkID(info.id);
  const sshUsername = `${permalinkID}_`;
  const password = generateNeedlesslySecureRandomPassword(12);
  definition.appYaml.capabilities = AppCapabilities.parse({});
  definition.appYaml.capabilities.ssh = SshCapability.parse({
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
        // This is from id_rsa_test.pub
        authorized_keys: [
          "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQCdn8+RxPD9QnKQJgVlZurVh3AwyeEtbdA79YKrOmekzgrkcwBslUw49Q2fzJubF+7bgyTnyK7U3Rr33bcbr8tPoSJgiRnnOfFBVbPOQJBBCGxD2Lx1MKkR/RwDacTeNAucK20snYazZLWUL1xHTjyv77bp0VcGGNLg8J3RPeJo6vyUtUuGQDOUlauyTXZXmnAvTXurl7JC3mrRZxusqe64HN2Tsom6Gn5MB55oaeoyVEdSGKsPjuCifYIWPj3SBdumcxPu3yo0vORTMPoEqMjCQZtqa1AYW7VFKb65sunJYCDelpmGOLWWI2M4UdXqBrg4X12AFPdRAPFTR/qgMYUljKIKe+WWwgofk4w2CsXUWlYbruVtqNroAW6y4FWQtDnYnwON5FdCINKcrNNnem+SA3zNrXKJjvv4cfUG+IIBuYUvUh3BaFX6ds6lL6Pio+HYqTXIzoeWiM3hpZHRMRWem5tW9OsEt0U8T9KevkKYRwm2XNCZPJmZsYW/hCLtN5ULr7RQNRzPjJJvsg4t71nK5M1qt0D6VrFkvAUAf7zubJsUddnkxudCp303/uYq6CooblaeGms2CswqAV8ur7uJNiI/g3S289AZIl5ilB4IMNFAohZs2AH355Bk22WzmnWAo5DiW1qqUlo7bQonfzxM7+xBULgky/vBzsLZo/3iSw== lorkin@wasmerburk",
        ],
      },
    ],
  });
  writeAppDefinition(dir, definition);

  const sshDeployment = await env.deployAppDir(dir);
  return {
    sshUsername,
    password,
    sshDeployment,
  };
};

/**
 * Executes a command over an interactive SSH shell and returns
 * its exit code, stdout and stderr.
 *
 * Implementation details:
 * - Opens conn.shell() and writes START/END sentinels.
 * - Waits for END in stdout to detect command completion.
 * - Extracts text between the second START and the END marker.
 * - Does this to achieve best effort stdout, but since the write
 *   is also output in stdout, as well as any shell formating, it's difficult
 *   to isolate the command's stdout using the shell alone
 * - Collects stderr from stream.stderr.
 *
 * Note: assumes a POSIX-like shell on the remote side.
 *
 * @param {Client} conn SSH2 client already connected.
 * @param {string} command Remote shell command to execute.
 * @returns {Promise<object>} Resolves with { code, stdout-ish, stderr-ish }.
 * Rejects on shell errors.
 */
async function sshShellExec(
  conn: Client,
  command: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const START = `__START_${Math.random().toString(36).slice(2)}__`;
  const END = `__END_${Math.random().toString(36).slice(2)}__`;
  return await new Promise((resolve, reject) => {
    console.info(`Ssh client trying to run: ${command}`);
    conn.shell((err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      let code = -1;
      let done = false;
      const parseCode = (buf: string): boolean => {
        const idx = buf.indexOf(`${END}:`);
        if (idx === -1) return false;
        const tail = buf.substring(idx + END.length + 1).trim();
        const match = tail.match(/(\d+)/);
        if (match) {
          code = parseInt(match[1], 10);
        }
        return true;
      };
      const finish = () => {
        if (done) return;
        done = true;
        try {
          stream.removeListener("data", onStdout);
        } catch (e) {
          console.error(`failed to remove listener from stdout: ${e}`);
        }
        try {
          stream.stderr.removeListener("data", onStderr);
        } catch (e) {
          console.error(`failed to remove listener from stderr: ${e}`);
        }
        const startIdx = stdout.indexOf(START);
        let endIdx = -1;
        if (startIdx !== -1) {
          endIdx = stdout.indexOf(END, startIdx);
        }
        let cmdOut = "";
        if (startIdx !== -1 && endIdx !== -1) {
          cmdOut = stdout.substring(startIdx + START.length, endIdx);
        } else if (startIdx !== -1) {
          cmdOut = stdout.substring(startIdx + START.length);
        }
        stream.end();
        resolve({ code, stdout: cmdOut, stderr });
      };
      const onStdout = (d: Buffer) => {
        stdout += d.toString();
        if (parseCode(stdout)) {
          finish();
        }
      };
      const onStderr = (d: Buffer) => {
        const t = d.toString();
        stderr += t;
        if (parseCode(stderr)) {
          finish();
        }
      };
      stream.on("data", onStdout);
      stream.stderr.on("data", onStderr);
      stream.on("close", () => {
        console.log("stream close");
      });
      stream.write(`echo ${START}\n`);
      stream.write(`${command}\n`);
      stream.write(`RC=$?\n`);
      stream.write(`echo ${END}:$RC\n`);
      stream.write(`echo ${END}:$RC 1>&2\n`);
    });
  });
}

test("app-ssh", async () => {
  const env = TestEnv.fromEnv();
  const { sshUsername, password, sshDeployment } = await setupApp(env);

  const hostname = new URL(sshDeployment.url).host;

  console.log(`SSH to ${sshUsername}@${hostname}, password: ${password}`);
  const conn = new Client();
  async function connectSshWithRetry(
    tries = 5,
    delayMs = 3000,
    withKey = "",
  ): Promise<void> {
    let lastErr: unknown = null;
    for (let i = 0; i < tries; i++) {
      console.info(`Connection attempt [${i}/${tries}]`);
      try {
        await new Promise<void>((resolve, reject) => {
          const onReady = () => {
            conn.removeListener("error", onError);
            resolve();
          };
          const onError = (e: unknown) => {
            conn.removeListener("ready", onReady);
            reject(e);
          };
          conn.once("ready", onReady);
          conn.once("error", onError);
          if (withKey) {
            conn.connect({
              host: hostname,
              port: 22,
              username: sshUsername,
              privateKey: readFileSync(withKey),
              readyTimeout: 5000,
            });
          } else {
            conn.connect({
              host: hostname,
              port: 22,
              username: sshUsername,
              password,
              readyTimeout: 5000,
            });
          }
        });
        return;
      } catch (e) {
        console.error(`Connection failed: ${e}`);
        lastErr = e;
        try {
          conn.end();
        } catch {
          continue;
        }
        await sleep(delayMs);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  const fileToAdd =
    "/data/ssh-e2e-" + Math.random().toString(36).slice(2) + ".txt";
  await connectSshWithRetry();
  try {
    console.info(`Starting tests on with ${sshUsername}@${hostname}`);
    const who = await sshShellExec(conn, "whoami");
    expect(who.code).toBe(0);
    // TODO(WAX-495): Enable test after done
    // expect(who.stdout.trim()).toBe(sshUsername);
    const testData = fileToAdd;
    const writeCmd = "printf abc123 > " + testData + " && cat " + testData;
    const io = await sshShellExec(conn, writeCmd);
    expect(io.code).toBe(0);
    // Quite tricky to extract exact a specific command's stdout from interractive shells, so we're happy with finding a substring
    expect(io.stdout).toContain("abc123");
    const checkData = await sshShellExec(
      conn,
      "test -d /data && echo ok || echo missing",
    );
    expect(checkData.code).toBe(0);
    expect(checkData.stdout).toContain("ok");

    const errCase = await sshShellExec(conn, "echo oops 1>&2; false");
    expect(errCase.code).not.toBe(0);
    expect(errCase.stderr).toContain("oops");
  } finally {
    conn.end();
  }

  // Connect with key
  console.log("Connect with key");
  await connectSshWithRetry(5, 5000, "./tests/ssh/id_rsa_test");
  try {
    const checkData = await sshShellExec(conn, `cat ${fileToAdd}`);
    expect(checkData.code).toBe(0);
    expect(checkData.stdout).toContain("abc123");
  } finally {
    conn.end();
  }

  // Cleanup app on success. If not, we can inspect the app via creds listed above
  env.deleteApp(sshDeployment);
});

test("app-sftp", async () => {
  const env = TestEnv.fromEnv();
  const { sshUsername, password, sshDeployment } = await setupApp(env);

  const hostname = new URL(sshDeployment.url).host;

  console.log(
    `SSH: userrname: ${sshUsername}, password: ${password}, hostname: ${hostname}`,
  );
  const sftp = new SftpClient();
  async function connectSftpWithRetry(
    tries = 5,
    delayMs = 3000,
  ): Promise<void> {
    let lastErr: unknown = null;
    for (let i = 0; i < tries; i++) {
      console.info(`Connection attempt [${i}/${tries}]`);
      try {
        await sftp.connect({
          host: hostname,
          port: 22,
          username: sshUsername,
          password,
          readyTimeout: 5000,
        });
        return;
      } catch (e) {
        console.error(`Connection failed: ${e}`);
        lastErr = e;
        await sleep(delayMs);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  const t0 = performance.now();

  await connectSftpWithRetry();
  const remotePath =
    "/data/node-lib-test-" + Math.random().toString(36).slice(2) + ".txt";
  try {
    console.info(
      `Connection OK! It took: ${performance.now() - t0}ms. Proceeding with tests`,
    );
    const data = Buffer.from("abc123");
    console.log(`Putting file to: ${remotePath}`);
    await sftp.put(data, remotePath);
    const list = await sftp.list("/data");
    const names = list.map((e: { name: string }) => e.name);
    console.log(`Checking file exists: ${JSON.stringify(list, null, " ")}`);
    expect(names).toContain(remotePath.split("/").pop() as string);
    const got = (await sftp.get(remotePath)) as Buffer;
    const text = Buffer.isBuffer(got)
      ? got.toString()
      : Buffer.from(got as ArrayBuffer).toString();
    console.log(`Validating file contents`);
    expect(text).toBe("abc123");
  } finally {
    await sftp.end();
  }

  // Connect again, expect files to still exist
  await connectSftpWithRetry();
  try {
    let list = await sftp.list("/data");
    let names = list.map((e: { name: string }) => e.name);
    console.log(
      `Validating that file exists after reconnect: ${JSON.stringify(list, null, " ")}`,
    );
    expect(names).toContain(remotePath.split("/").pop() as string);
    const got = (await sftp.get(remotePath)) as Buffer;
    const text = Buffer.isBuffer(got)
      ? got.toString()
      : Buffer.from(got as ArrayBuffer).toString();
    console.log(`Validating file contents`);
    expect(text).toBe("abc123");
    console.log(`Deleting file: ${remotePath}`);
    sftp.delete(remotePath);
    list = await sftp.list("/data");
    names = list.map((e: { name: string }) => e.name);
    expect(names).not.toContain(remotePath.split("/").pop() as string);
  } finally {
    await sftp.end();
  }

  await expect(
    (async () => {
      const bad = new SftpClient();
      try {
        await bad.connect({
          host: hostname,
          port: 22,
          username: sshUsername,
          password: password + "x",
          readyTimeout: 15000,
        });
      } finally {
        await bad.end();
      }
    })(),
  ).rejects.toBeTruthy();

  // Cleanup app on success. If not, we can inspect the app via creds listed above
  env.deleteApp(sshDeployment);
});
