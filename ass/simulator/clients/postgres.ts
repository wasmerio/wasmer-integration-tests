// Guarded Postgres factory (D-K layer two) plus the D-B live-column
// assertion. Writers get a connection only through here, and the loopback
// check runs immediately before every connect — independent of the verb
// guard, with no override of any kind. The column assertion runs before any
// insert so backend schema drift (resolve_prod moves under us) fails fast
// and names the delta instead of half-populating the dashboard.

import { Client } from "pg";
import { guardedUrl } from "../guard";

export class SchemaDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaDriftError";
  }
}

/** Connect to the backend Postgres named by `LOCAL_PLATFORM_POSTGRES_URL`.
 * The URL is re-guarded here even though the verb entry already checked it:
 * the two layers must fail independently (D-K). */
export async function connectSimulatorPostgres(
  env: Record<string, string>,
): Promise<Client> {
  const url = env["LOCAL_PLATFORM_POSTGRES_URL"];
  if (url === undefined || url.trim() === "") {
    throw new SchemaDriftError(
      "LOCAL_PLATFORM_POSTGRES_URL missing from the platform env — cannot " +
        "verify a loopback target, refusing to connect",
    );
  }
  const guarded = guardedUrl("LOCAL_PLATFORM_POSTGRES_URL", url);
  // The local platform's Postgres speaks plaintext on a loopback port.
  const client = new Client({
    connectionString: guarded,
    connectionTimeoutMillis: 15_000,
    query_timeout: 60_000,
  });
  await client.connect();
  return client;
}

/** D-B: compare the columns a writer is about to touch against the live
 * table. Extra live columns are fine (inserts name their columns); a
 * missing or retyped one is fatal. */
export async function assertTableColumns(
  client: Client,
  table: string,
  expected: Record<string, string>,
): Promise<void> {
  const result = await client.query<{
    column_name: string;
    data_type: string;
  }>(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  if (result.rows.length === 0) {
    throw new SchemaDriftError(
      `backend table "${table}" does not exist — the backend schema has ` +
        "moved under resolve_prod; the simulator's writer needs updating",
    );
  }
  const live = new Map(
    result.rows.map((row) => [row.column_name, row.data_type]),
  );
  const problems: string[] = [];
  for (const [column, type] of Object.entries(expected)) {
    const liveType = live.get(column);
    if (liveType === undefined) {
      problems.push(`missing column ${table}.${column} (expected ${type})`);
    } else if (liveType !== type) {
      problems.push(
        `retyped column ${table}.${column}: live ${liveType}, expected ${type}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new SchemaDriftError(
      `backend schema drift detected (writer vs live database):\n  ` +
        problems.join("\n  ") +
        "\nThe backend moved under resolve_prod; update the simulator's " +
        "writer to match before seeding.",
    );
  }
}
