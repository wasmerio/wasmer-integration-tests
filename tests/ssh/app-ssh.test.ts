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

async function connectWithRetry(
  host: string,
  username: string,
  password: string,
  tries = 5,
  delayMs = 3000,
): Promise<Client> {
  console.time("ssh-con");
  let lastErr: unknown = null;
  for (let i = 0; i < tries; i++) {
    const conn = new Client();
    try {
      const conOpt = { host, port: 22, username, password, readyTimeout: 5000 };
      console.log(JSON.stringify(conOpt, null, " "));
      console.info(`Connection attempt [${i + 1}/${tries}]`);
      conn
        .on("ready", () => () => {
          console.info("client ready");
        })
        .on("error", (e) => {
          throw e;
        })
        .connect(conOpt);
      console.timeEnd("ssh-con");
      return conn;
    } catch (e) {
      console.error(`Connect error: ${e}`);
      lastErr = e;
      conn.end();
      await sleep(delayMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : lastErr;
}

async function sshShellExec(
  conn: Client,
  command: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const START = `__START_${Math.random().toString(36).slice(2)}__`;
  const END = `__END_${Math.random().toString(36).slice(2)}__`;
  return await new Promise((resolve, reject) => {
    console.info(`Ssh client trying to run: ${command}`);
    conn.shell((err, stream) => {
      console.info("Hello, I reach?");
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      let code = -1;
      const onData = (d: Buffer) => {
        stdout += d.toString();
        const idx = stdout.indexOf(`${END}:`);
        if (idx !== -1) {
          const tail = stdout.substring(idx + END.length + 1).trim();
          const match = tail.match(/^(\d+)/);
          if (match) {
            code = parseInt(match[1], 10);
          }
          const startIdx = stdout.indexOf(START);
          const cmdOut =
            startIdx !== -1
              ? stdout
                .substring(startIdx + START.length)
                .split("\n")
                .slice(1)
                .join("\n")
                .split(`\n${END}:`)[0]
              : stdout;
          stream.removeListener("data", onData);
          stream.end();
          resolve({ code, stdout: cmdOut, stderr });
        }
      };
      stream.on("data", onData);
      stream.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      stream.on("close", () => {
        console.log("Stream :: close");
        conn.end();
      });
      stream.write(`echo ${START}\n${command}\nRC=$?\necho ${END}:$RC\n`);
      stream.end("ls -l\nexit\n");
    });
  });
}

test("app-ssh", async () => {
  // const env = TestEnv.fromEnv();
  // const { sshUsername, password, sshDeployment } = await setupApp(env);
  //
  // const hostname = new URL(sshDeployment.url).host;
  //
  // console.log(
  //   `SSH: userrname: ${sshUsername}, password: ${password}, hostname: ${hostname}`,
  // );
  const sshUsername = "r3dhki1t8w03_";
  const hostname = "t-b32ae3a876954909bf4d.wasmer.dev";
  const password = "@N)Q*e_dn0N9";
  const sshClient = await connectWithRetry(hostname, sshUsername, password);
  try {
    console.info(`Starting tests on with ${sshUsername}@${hostname}`);
    // const who = await sshShellExec(sshClient, "whoami");
    // expect(who.code).toBe(0);
    // expect(who.stdout.trim()).toBe(sshUsername);
    //
    // const testData =
    //   "/data/ssh-e2e-" + Math.random().toString(36).slice(2) + ".txt";
    // const writeCmd = "printf abc123 > " + testData + " && cat " + testData;
    // const io = await sshShellExec(sshClient, writeCmd);
    // expect(io.code).toBe(0);
    // expect(io.stdout.trim()).toBe("abc123");
    //
    // const checkData = await sshShellExec(
    //   sshClient,
    //   "test -d /data && echo ok || echo missing",
    // );
    // expect(checkData.code).toBe(0);
    // expect(checkData.stdout).toContain("ok");
    //
    // const errCase = await sshShellExec(sshClient, "echo oops 1>&2; false");
    // expect(errCase.code).not.toBe(0);
    // expect(errCase.stderr).toContain("oops");
  } finally {
    sshClient.end();
  }

  await expect(
    connectWithRetry(hostname, sshUsername, password + "x", 1, 500),
  ).rejects.toBeTruthy();
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

  // Cleanup app
  env.deleteApp(sshDeployment);
});
