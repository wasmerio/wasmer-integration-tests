import * as net from "node:net";
import { Client } from "pg";

// Connection details for a managed app database. Mirrors the injected app
// env vars (DB_HOST/DB_PORT/DB_NAME/DB_USERNAME/DB_PASSWORD).
export interface PostgresCredentials {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

// TCP reachability probe. The managed database endpoint may not be reachable
// from every runner (e.g. a laptop without access to the local-platform
// docker network), so tests probe before deciding to run direct SQL checks.
export function canReachTcp(
  host: string,
  port: number,
  timeoutMs = 10_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

// Connect to a managed PostgreSQL database.
//
// The hosted instances (OVH) serve TLS with a private "Project CA" that does
// not verify against system roots, so certificate verification is disabled —
// this matches the `sslmode=require` guidance in the user docs. Local
// platform instances do not speak TLS at all, so on an SSL-specific failure
// we retry in plaintext.
export async function connectPostgres(
  creds: PostgresCredentials,
): Promise<Client> {
  const base = {
    host: creds.host,
    port: creds.port,
    database: creds.database,
    user: creds.user,
    password: creds.password,
    connectionTimeoutMillis: 15_000,
    query_timeout: 30_000,
  };

  const withTls = new Client({ ...base, ssl: { rejectUnauthorized: false } });
  try {
    await withTls.connect();
    return withTls;
  } catch (error) {
    await withTls.end().catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    if (!/ssl/i.test(message)) {
      throw error;
    }
    const plaintext = new Client(base);
    await plaintext.connect();
    return plaintext;
  }
}

export async function withPostgres<T>(
  creds: PostgresCredentials,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await connectPostgres(creds);
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}
