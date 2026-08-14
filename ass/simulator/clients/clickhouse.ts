// Guarded ClickHouse HTTP client (D-K layer two): the endpoint is re-checked
// as loopback immediately before every request, independent of the verb
// guard, with no override. Credentials come from the platform's test-env.sh
// only. The D-B live-schema assertion lives here so every writer runs it
// through the same code path.

import { Buffer } from "node:buffer";
import { guardedUrl } from "../guard";

export class ClickHouseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClickHouseError";
  }
}

export class SchemaDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaDriftError";
  }
}

export class SimulatorClickHouse {
  private readonly url: string;
  private readonly auth: string;
  readonly database: string;

  constructor(env: Record<string, string>) {
    const raw = env["LOCAL_PLATFORM_CLICKHOUSE_URL"];
    if (raw === undefined || raw.trim() === "") {
      throw new ClickHouseError(
        "LOCAL_PLATFORM_CLICKHOUSE_URL missing from the platform env — " +
          "cannot verify a loopback target, refusing to connect",
      );
    }
    this.url = guardedUrl("LOCAL_PLATFORM_CLICKHOUSE_URL", raw);
    const username = env["LOCAL_PLATFORM_CLICKHOUSE_USERNAME"] ?? "default";
    const password = env["LOCAL_PLATFORM_CLICKHOUSE_PASSWORD"] ?? "";
    this.auth = Buffer.from(`${username}:${password}`).toString("base64");
    this.database =
      env["LOCAL_PLATFORM_CLICKHOUSE_DATABASE"] ?? "edge_metrics_local";
  }

  /** Raw SQL over HTTP; the guard re-runs per call by construction (the URL
   * was guarded at build time and is immutable). */
  async query(sql: string, timeoutMs = 120_000): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${this.auth}`,
          "Content-Type": "text/plain; charset=utf-8",
        },
        body: sql,
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new ClickHouseError(
          `ClickHouse query failed (${response.status}): ${body.slice(0, 500)}`,
        );
      }
      // A failure raised *after* the response headers are sent — an async
      // insert that fails to parse is the common one — arrives as HTTP 200
      // with the exception in the body and a header naming its code.
      // Without this check a broken insert reads as success and the data
      // silently never lands (observed live, 2026-08-18).
      const exceptionCode = response.headers.get("x-clickhouse-exception-code");
      if (
        exceptionCode !== null ||
        /^Code: \d+\. DB::Exception/.test(body.trimStart())
      ) {
        throw new ClickHouseError(
          `ClickHouse reported an exception after starting the response` +
            `${exceptionCode !== null ? ` (code ${exceptionCode})` : ""}: ${body.slice(0, 500)}`,
        );
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  async count(table: string, where: string): Promise<number> {
    const body = await this.query(
      `SELECT count() FROM ${this.database}.${table} WHERE ${where}`,
    );
    return Number(body.trim());
  }

  async describeTable(table: string): Promise<Map<string, string>> {
    const body = await this.query(
      `DESCRIBE TABLE ${this.database}.${table} FORMAT TSV`,
    );
    const columns = new Map<string, string>();
    for (const line of body.split("\n")) {
      const [name, type] = line.split("\t");
      if (name !== undefined && name !== "" && type !== undefined) {
        columns.set(name, type);
      }
    }
    return columns;
  }

  /** D-B: fail fast, naming table, delta, and the generating source. */
  async assertColumns(
    table: string,
    expected: Record<string, string>,
  ): Promise<void> {
    let live: Map<string, string>;
    try {
      live = await this.describeTable(table);
    } catch (err) {
      throw new SchemaDriftError(
        `cannot describe ${this.database}.${table}: ` +
          `${err instanceof Error ? err.message : String(err)} — the Edge ` +
          "metrics schema (edge/crates/metrics/src/store/clickhouse/" +
          "migrations.rs) has moved under resolve_prod",
      );
    }
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
        "ClickHouse schema drift detected (writer vs live table):\n  " +
          problems.join("\n  ") +
          "\nGenerating source: wasmer/edge/crates/metrics/src/store/" +
          "clickhouse/migrations.rs — update the simulator's writer to " +
          "match before seeding.",
      );
    }
  }

  /** ALTER DELETE (mutation) + verification probe: mutations are async, so
   * completion is proven by the count reaching zero, polled with a
   * timeout. Returns error strings, never throws (teardown contract). */
  async deleteWhere(
    table: string,
    where: string,
    timeoutMs = 90_000,
  ): Promise<string[]> {
    try {
      await this.query(
        `ALTER TABLE ${this.database}.${table} DELETE WHERE ${where} ` +
          "SETTINGS mutations_sync = 1",
        timeoutMs,
      );
    } catch (err) {
      return [
        `delete from ${table}: ${err instanceof Error ? err.message : String(err)}`,
      ];
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let remaining: number;
      try {
        remaining = await this.count(table, where);
      } catch (err) {
        return [
          `verify delete from ${table}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        ];
      }
      if (remaining === 0) {
        return [];
      }
      if (Date.now() > deadline) {
        return [
          `delete from ${table} still shows ${remaining} rows after ` +
            `${Math.round(timeoutMs / 1000)}s (mutation pending?) — re-run ` +
            "ass down to retry",
        ];
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
