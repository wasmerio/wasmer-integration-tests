import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "ssh2";
import SftpClient from "ssh2-sftp-client";
import { z } from "zod";

import { TestEnv } from "./env";
import { sleep } from "./util";

export interface SshTarget {
  host: string;
  port: number;
}

export interface SshExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SshConnectionOptions extends SshTarget {
  username: string;
  password?: string;
  privateKey?: Buffer | string;
  tries?: number;
  delayMs?: number;
  readyTimeout?: number;
}

export type SshAuthenticationMethod = "PASSWORD" | "PUBLIC_KEY";

const sshUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  serverHost: z.string(),
  port: z.number(),
  sftpRootFolder: z.string(),
});

export type SshUser = z.infer<typeof sshUserSchema>;

const sshServerSchema = z.object({
  enabled: z.boolean(),
  users: z.object({
    edges: z.array(
      z.object({
        node: sshUserSchema,
      }),
    ),
  }),
});

const toggleSshServerResponseSchema = z.object({
  toggleSshServer: z.object({
    sshServer: sshServerSchema,
  }),
});

const editSshUserResponseSchema = z.object({
  editSshUser: z.object({
    sshUser: sshUserSchema,
  }),
});

const addSshAuthorizedKeyResponseSchema = z.object({
  addSshAuthorizedKey: z.object({
    authorizedKey: z.object({
      id: z.string(),
    }),
  }),
});

export const TEST_SSH_PRIVATE_KEY_PATH = path.join(
  process.cwd(),
  "tests/ssh/id_rsa_test",
);
export const TEST_SSH_PUBLIC_KEY_PATH = `${TEST_SSH_PRIVATE_KEY_PATH}.pub`;

export function readTestSshPrivateKey(): Buffer {
  return readFileSync(TEST_SSH_PRIVATE_KEY_PATH);
}

export async function readTestSshPublicKey(): Promise<string> {
  return (await readFile(TEST_SSH_PUBLIC_KEY_PATH, "utf8")).trim();
}

export function edgeSshCliArgs(env: TestEnv): string[] {
  const target = env.edgeSshTarget();
  if (!target) {
    return [];
  }

  return ["--host", target.host, "--ssh-port", String(target.port)];
}

export function sshTargetForUser(env: TestEnv, sshUser: SshUser): SshTarget {
  return (
    env.edgeSshTarget() ?? { host: sshUser.serverHost, port: sshUser.port }
  );
}

function firstSshUser(server: z.infer<typeof sshServerSchema>): SshUser {
  if (!server.enabled) {
    throw new Error("SSH server was not enabled after toggleSshServer");
  }

  const user = server.users.edges[0]?.node;
  if (!user) {
    throw new Error("SSH server is enabled, but no SSH users were returned");
  }

  return user;
}

export async function enableAppSshServer(
  env: TestEnv,
  appId: string,
): Promise<SshUser> {
  const response = await env.backend.gqlQuery<unknown>(
    `
      mutation ToggleSshServer($appId: ID!) {
        toggleSshServer(input: { appId: $appId, enabled: true }) {
          sshServer {
            enabled
            users(first: 10) {
              edges {
                node {
                  id
                  username
                  serverHost
                  port
                  sftpRootFolder
                }
              }
            }
          }
        }
      }
    `,
    { appId },
  );

  const parsed = toggleSshServerResponseSchema.parse(response.data);
  return firstSshUser(parsed.toggleSshServer.sshServer);
}

export async function setSshUserAuthenticationMethods(
  env: TestEnv,
  sshUserId: string,
  authenticationMethods: SshAuthenticationMethod[],
): Promise<SshUser> {
  const response = await env.backend.gqlQuery<unknown>(
    `
      mutation EditSshUser(
        $id: ID!
        $authenticationMethods: [SshAuthenticationMethod]
      ) {
        editSshUser(
          input: {
            id: $id
            authenticationMethods: $authenticationMethods
          }
        ) {
          sshUser {
            id
            username
            serverHost
            port
            sftpRootFolder
          }
        }
      }
    `,
    {
      id: sshUserId,
      authenticationMethods,
    },
  );

  return editSshUserResponseSchema.parse(response.data).editSshUser.sshUser;
}

export async function addSshAuthorizedKey(
  env: TestEnv,
  sshUserId: string,
  publicKey: string,
  name = "wasmer-integration-tests",
): Promise<void> {
  const response = await env.backend.gqlQuery<unknown>(
    `
      mutation AddSshAuthorizedKey(
        $sshUserId: ID!
        $publicKey: String!
        $name: String
      ) {
        addSshAuthorizedKey(
          input: {
            sshUserId: $sshUserId
            publicKey: $publicKey
            name: $name
          }
        ) {
          authorizedKey {
            id
          }
        }
      }
    `,
    {
      sshUserId,
      publicKey,
      name,
    },
  );

  addSshAuthorizedKeyResponseSchema.parse(response.data);
}

/**
 * Enables the managed app SSH server and grants the checked-in integration-test
 * key access to its first user.
 *
 * This is needed for StackMachine-managed apps, where SSH users are created by
 * backend mutations after deployment. Apps deployed from app.yaml can instead
 * define capabilities.ssh.users directly in app.yaml before deploy.
 */
export async function enableAppSshWithTestKey(
  env: TestEnv,
  appId: string,
): Promise<SshUser> {
  const sshUser = await enableAppSshServer(env, appId);
  const updatedSshUser = await setSshUserAuthenticationMethods(
    env,
    sshUser.id,
    ["PUBLIC_KEY"],
  );
  await addSshAuthorizedKey(
    env,
    updatedSshUser.id,
    await readTestSshPublicKey(),
  );
  return updatedSshUser;
}

export async function connectSshWithRetry(
  options: SshConnectionOptions,
): Promise<Client> {
  const tries = options.tries ?? 5;
  const delayMs = options.delayMs ?? 3000;
  const readyTimeout = options.readyTimeout ?? 5000;
  let lastErr: unknown = null;

  for (let i = 0; i < tries; i++) {
    const conn = new Client();
    console.info(`SSH connection attempt [${i}/${tries}]`);
    try {
      await new Promise<void>((resolve, reject) => {
        const onReady = () => {
          conn.removeListener("error", onError);
          resolve();
        };
        const onError = (error: unknown) => {
          conn.removeListener("ready", onReady);
          reject(error);
        };
        conn.once("ready", onReady);
        conn.once("error", onError);
        conn.connect({
          host: options.host,
          port: options.port,
          username: options.username,
          password: options.password,
          privateKey: options.privateKey,
          readyTimeout,
        });
      });
      return conn;
    } catch (error) {
      console.error(`SSH connection failed: ${error}`);
      lastErr = error;
      conn.end();
      await sleep(delayMs);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function connectSftpWithRetry(
  sftp: SftpClient,
  options: SshConnectionOptions,
): Promise<void> {
  const tries = options.tries ?? 5;
  const delayMs = options.delayMs ?? 3000;
  const readyTimeout = options.readyTimeout ?? 5000;
  let lastErr: unknown = null;

  for (let i = 0; i < tries; i++) {
    console.info(`SFTP connection attempt [${i}/${tries}]`);
    try {
      await sftp.connect({
        host: options.host,
        port: options.port,
        username: options.username,
        password: options.password,
        privateKey: options.privateKey,
        readyTimeout,
      });
      return;
    } catch (error) {
      console.error(`SFTP connection failed: ${error}`);
      lastErr = error;
      await sleep(delayMs);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function sshExec(
  conn: Client,
  command: string,
  allowNonZeroExitCode = false,
): Promise<SshExecResult> {
  return await new Promise((resolve, reject) => {
    conn.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let stdout = "";
      let stderr = "";
      let code: number | undefined;

      stream.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      stream.on("exit", (exitCode?: number) => {
        code = exitCode ?? 0;
      });
      stream.on("close", () => {
        if (code === undefined) {
          reject(
            new Error(
              `SSH command closed before exit code was observed: command=${command}, stdout=${stdout}, stderr=${stderr}`,
            ),
          );
          return;
        }

        if (!allowNonZeroExitCode && code !== 0) {
          reject(
            new Error(
              `SSH command failed: command=${command}, code=${code}, stdout=${stdout}, stderr=${stderr}`,
            ),
          );
          return;
        }

        resolve({ code, stdout, stderr });
      });
    });
  });
}

/**
 * Executes a command over an interactive SSH shell and returns its exit code,
 * best-effort stdout, and stderr.
 *
 * Prefer sshExec() for non-interactive SSH. This helper exists for app SSH
 * environments where exec is not consistently available unless EDGE_SSH_SERVER
 * is set.
 */
export async function sshShellExec(
  conn: Client,
  command: string,
  allowNonZeroExitCode = false,
): Promise<SshExecResult> {
  if (process.env.EDGE_SSH_SERVER) {
    try {
      return await sshExec(conn, command, allowNonZeroExitCode);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("Unable to exec")
      ) {
        throw error;
      }
    }
  }

  const START = `__START_${Math.random().toString(36).slice(2)}__`;
  const END = `__END_${Math.random().toString(36).slice(2)}__`;
  // The PTY echoes our typed input back, so the buffer contains
  // "echo __END__:$RC" (literal $RC) before the real "__END__:<code>" line.
  // Requiring digits directly after the colon skips the echoed input.
  const endMarkerRe = new RegExp(`${END}:(\\d+)`);
  return await new Promise((resolve, reject) => {
    console.info(`SSH shell trying to run: ${command}`);
    conn.shell((error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let stdout = "";
      let stderr = "";
      let code: number | undefined;
      let done = false;

      const parseCode = (buf: string, isFinal = false): boolean => {
        if (code !== undefined) {
          return true;
        }
        const lines = buf.split(/\r?\n/);
        // While streaming, the last element is an incomplete line: a chunk
        // boundary could truncate the exit code (e.g. "127" read as "12").
        const complete = isFinal ? lines : lines.slice(0, -1);
        for (const line of complete) {
          const match = line.match(endMarkerRe);
          if (match) {
            code = parseInt(match[1], 10);
            return true;
          }
        }
        return false;
      };

      const finish = () => {
        if (done) {
          return;
        }
        done = true;
        stream.removeListener("data", onStdout);
        stream.stderr.removeListener("data", onStderr);
        if (!parseCode(stdout, true)) {
          parseCode(stderr, true);
        }

        // Collect output between the START marker line and the END marker
        // line, dropping echoes of the helper's own injected commands.
        const lines = stdout.split(/\r?\n/);
        const startIdx = lines.findIndex((line) => line.trim() === START);
        const outLines: string[] = [];
        for (const line of lines.slice(startIdx + 1)) {
          const endMatch = line.match(endMarkerRe);
          if (endMatch) {
            // Output without a trailing newline shares its line with the
            // marker (e.g. `{"status":"ok"}__END__:0`); keep the prefix.
            const prefix = line.slice(0, endMatch.index ?? 0);
            if (prefix.trim() !== "") {
              outLines.push(prefix);
            }
            break;
          }
          if (
            line.includes(START) ||
            line.includes(END) ||
            line.trim() === "RC=$?"
          ) {
            continue;
          }
          outLines.push(line);
        }
        const cmdOut = outLines.join("\n").replace(/^\r?\n/, "");
        stderr = stderr
          .split(/\r?\n/)
          .filter((line) => !line.includes(END))
          .join("\n");

        if (code === undefined) {
          reject(
            new Error(
              `SSH command closed before exit code marker was observed: command=${command}, stdout=${cmdOut}, stderr=${stderr}`,
            ),
          );
          return;
        }
        if (!allowNonZeroExitCode && code !== 0) {
          reject(
            new Error(
              `SSH command failed: command=${command}, code=${code}, stdout=${cmdOut}, stderr=${stderr}`,
            ),
          );
          return;
        }

        stream.end();
        resolve({ code, stdout: cmdOut, stderr });
      };

      const onStdout = (data: Buffer) => {
        stdout += data.toString();
        if (parseCode(stdout)) {
          stream.end();
        }
      };
      const onStderr = (data: Buffer) => {
        stderr += data.toString();
        if (parseCode(stderr)) {
          stream.end();
        }
      };

      stream.on("data", onStdout);
      stream.stderr.on("data", onStderr);
      stream.on("close", finish);
      stream.write(`echo ${START}\n`);
      stream.write(`${command}\n`);
      stream.write("RC=$?\n");
      stream.write(`echo ${END}:$RC\n`);
      stream.write(`echo ${END}:$RC 1>&2\n`);
    });
  });
}
