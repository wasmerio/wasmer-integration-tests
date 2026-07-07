import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import SftpClient from "ssh2-sftp-client";

import { createTempDir, TestEnv } from "../../src";
import {
  AppCapabilities,
  SshCapability,
  writeAppDefinition,
} from "../../src/app/construct";
import { generateNeedlesslySecureRandomPassword } from "../../src/security";
import { preparePhpTestserverApp } from "../utils/php-testserver";
import {
  connectSftpWithRetry,
  connectSshWithRetry,
  edgeSshCliArgs,
  readTestSshPrivateKey,
  readTestSshPublicKey,
  sshShellExec,
  TEST_SSH_PRIVATE_KEY_PATH,
} from "../../src/ssh";

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runScp(args: string[]): Promise<CommandResult> {
  console.info(`Running scp ${args.join(" ")}`);
  const proc = spawn("scp", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const timeoutMs = 120_000;

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(
        new Error(`scp timed out after ${timeoutMs}ms: scp ${args.join(" ")}`),
      );
    }, timeoutMs);

    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on("close", (code) => {
      clearTimeout(timeout);
      const result = {
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      };
      if (code !== 0) {
        reject(
          new Error(
            `scp failed with code ${code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

async function snapshotDirectory(
  root: string,
): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};

  async function visit(dir: string): Promise<void> {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const fullPath = path.join(dir, dirent.name);
      const relativePath = path
        .relative(root, fullPath)
        .split(path.sep)
        .join("/");
      if (dirent.isDirectory()) {
        await visit(fullPath);
      } else if (dirent.isFile()) {
        entries[relativePath] = await fs.readFile(fullPath, "utf8");
      }
    }
  }

  await visit(root);
  return entries;
}

const setupApp = async (env: TestEnv) => {
  const { dir, definition } = await preparePhpTestserverApp(env);
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
        authorized_keys: [await readTestSshPublicKey()],
      },
    ],
  });
  await writeAppDefinition(dir, definition);

  const sshDeployment = await env.deployAppDir(dir);
  return {
    sshUsername,
    password,
    sshDeployment,
    dir,
  };
};

test("app-ssh", async () => {
  const env = TestEnv.fromEnv();
  const { sshUsername, password, sshDeployment } = await setupApp(env);

  const target = env.edgeSshTarget();
  const hostname = target?.host ?? new URL(sshDeployment.url).hostname;
  const port = target?.port ?? 22;

  console.log(`SSH to ${sshUsername}@${hostname}:${port}`);

  try {
    const fileToAdd =
      "/data/ssh-e2e-" + Math.random().toString(36).slice(2) + ".txt";
    const passwordConn = await connectSshWithRetry({
      host: hostname,
      port,
      username: sshUsername,
      password,
    });
    try {
      console.info(`Starting tests on with ${sshUsername}@${hostname}`);
      const who = await sshShellExec(passwordConn, "whoami");
      expect(who.code).toBe(0);
      // TODO(WAX-495): Enable test after done
      // expect(who.stdout.trim()).toBe(sshUsername);
      const testData = fileToAdd;
      const writeCmd = "printf abc123 > " + testData + " && cat " + testData;
      const io = await sshShellExec(passwordConn, writeCmd);
      expect(io.code).toBe(0);
      // Quite tricky to extract exact a specific command's stdout from interractive shells, so we're happy with finding a substring
      expect(io.stdout).toContain("abc123");
      const checkData = await sshShellExec(
        passwordConn,
        "test -d /data && echo ok || echo missing",
      );
      expect(checkData.code).toBe(0);
      expect(checkData.stdout).toContain("ok");

      const errCase = await sshShellExec(
        passwordConn,
        "echo oops 1>&2; false",
        true,
      );
      expect(errCase.code).not.toBe(0);
      expect(errCase.stderr).toContain("oops");
    } finally {
      passwordConn.end();
    }

    // Connect with key
    console.log("Connect with key");
    const keyConn = await connectSshWithRetry({
      host: hostname,
      port,
      username: sshUsername,
      privateKey: readTestSshPrivateKey(),
      tries: 5,
      delayMs: 5000,
    });
    try {
      const checkData = await sshShellExec(keyConn, `cat ${fileToAdd}`);
      expect(checkData.code).toBe(0);
      expect(checkData.stdout).toContain("abc123");
    } finally {
      keyConn.end();
    }
  } finally {
    await env.deleteApp(sshDeployment);
  }
});

test("wasmer ssh can target an app by flag or app.yaml", async () => {
  const env = TestEnv.fromEnv();
  const { sshDeployment, dir } = await setupApp(env);
  const targetArgs = edgeSshCliArgs(env);

  try {
    await env.runWasmerCommand({
      args: [
        "ssh",
        "--app",
        sshDeployment.id,
        ...targetArgs,
        "--",
        "test",
        "-d",
        "/data",
      ],
    });

    await env.runWasmerCommand({
      args: ["ssh", ...targetArgs, "--", "test", "-d", "/data"],
      cwd: dir,
    });
  } finally {
    await env.deleteApp(sshDeployment);
  }
});

test("app-sftp", async () => {
  const env = TestEnv.fromEnv();
  const { sshUsername, password, sshDeployment } = await setupApp(env);

  const target = env.edgeSshTarget();
  const hostname = target?.host ?? new URL(sshDeployment.url).hostname;
  const port = target?.port ?? 22;

  console.log(`SFTP to ${sshUsername}@${hostname}:${port}`);
  const sftp = new SftpClient();

  const t0 = performance.now();

  try {
    await connectSftpWithRetry(sftp, {
      host: hostname,
      port,
      username: sshUsername,
      password,
    });
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
    await connectSftpWithRetry(sftp, {
      host: hostname,
      port,
      username: sshUsername,
      password,
    });
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
      await sftp.delete(remotePath);
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
            port,
            username: sshUsername,
            password: password + "x",
            readyTimeout: 15000,
          });
        } finally {
          await bad.end();
        }
      })(),
    ).rejects.toBeTruthy();
  } finally {
    await env.deleteApp(sshDeployment);
  }
});

test("app-scp", async () => {
  const env = TestEnv.fromEnv();
  const { sshUsername, sshDeployment } = await setupApp(env);

  const target = env.edgeSshTarget();
  const hostname = target?.host ?? new URL(sshDeployment.url).hostname;
  const port = target?.port ?? 22;
  const tmpDir = await createTempDir();
  const downloadDir = await createTempDir();
  const fixtureName = `scp-e2e-${crypto.randomUUID()}`;
  const fixtureDir = path.join(tmpDir, fixtureName);
  const privateKeyPath = path.join(tmpDir, "id_rsa_test");
  const remoteDir = `/data/${fixtureName}`;

  await fs.copyFile(TEST_SSH_PRIVATE_KEY_PATH, privateKeyPath);
  await fs.chmod(privateKeyPath, 0o600);
  await fs.mkdir(path.join(fixtureDir, "nested", "deeper"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(fixtureDir, "root.txt"),
    `root file ${fixtureName}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureDir, "nested", "child.txt"),
    `nested file ${fixtureName}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureDir, "nested", "deeper", "binary-ish.txt"),
    "line one\nline two\nsymbols: !@#$%^&*()\n",
    "utf8",
  );

  const scpBaseArgs = [
    "-r",
    "-P",
    String(port),
    "-i",
    privateKeyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
  ];

  try {
    console.log(`SCP to ${sshUsername}@${hostname}:${port}`);
    await runScp([
      ...scpBaseArgs,
      fixtureDir,
      `${sshUsername}@${hostname}:/data/`,
    ]);
    await runScp([
      ...scpBaseArgs,
      `${sshUsername}@${hostname}:${remoteDir}`,
      downloadDir,
    ]);

    await expect(
      snapshotDirectory(path.join(downloadDir, fixtureName)),
    ).resolves.toEqual(await snapshotDirectory(fixtureDir));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(downloadDir, { recursive: true, force: true });
    await env.deleteApp(sshDeployment);
  }
});
