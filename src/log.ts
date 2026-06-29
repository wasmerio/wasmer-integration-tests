import { Buffer } from "node:buffer";
import { fail } from "node:assert";

import { isVerboseEnabled, TestEnv } from "./env";
import { sleep } from "./util";

export function countSubstrings(str: string, subStr: string): number {
  if (subStr === "") {
    return 0;
  }
  let count = 0;
  let pos = str.indexOf(subStr);
  while (pos !== -1) {
    count++;
    pos = str.indexOf(subStr, pos + 1);
  }
  return count;
}

const LOG_POLL_INTERVAL_MS = 3000;
const DEFAULT_FAILURE_LOG_LENGTH = 4000;
const LOCAL_PLATFORM_CLICKHOUSE_QUERY_LIMIT = 1000;

function truncateFailureLogs(logs: string): string {
  if (isVerboseEnabled()) {
    return logs;
  }

  const maxLength = Number(
    process.env.MAX_LOG_SNIFF_FAILURE_LENGTH ?? DEFAULT_FAILURE_LOG_LENGTH,
  );
  if (logs.length <= maxLength) {
    return logs;
  }

  return `${logs.slice(-maxLength)}\n... and ${logs.length - maxLength} earlier characters omitted (rerun with VERBOSE=true to see all logs)`;
}

function isLocalPlatformLogFallbackEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(
    process.env.LOCAL_PLATFORM_RELAX_EDGE_VERSION_HEADER ?? "",
  );
}

function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function queryLocalPlatformClickHouse(query: string): Promise<string> {
  const endpoint =
    process.env.LOCAL_PLATFORM_CLICKHOUSE_URL ??
    `http://localhost:${process.env.CLICKHOUSE_HTTP_PORT ?? "18123"}`;
  const username = process.env.LOCAL_PLATFORM_CLICKHOUSE_USERNAME ?? "default";
  const password = process.env.LOCAL_PLATFORM_CLICKHOUSE_PASSWORD ?? "root";
  const authHeader = Buffer.from(`${username}:${password}`).toString("base64");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authHeader}`,
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: query,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `ClickHouse query failed (${response.status}): ${body.slice(0, 500)}`,
    );
  }

  return body;
}

async function getLocalPlatformLogsFromClickHouse(
  env: TestEnv,
  appName: string,
  sinceMs: number,
): Promise<string> {
  const database =
    process.env.LOCAL_PLATFORM_CLICKHOUSE_DATABASE ?? "edge_metrics_local";
  const bufferedSinceMs = sinceMs - 60 * 1000;
  const sinceIso = new Date(bufferedSinceMs).toISOString().replace("Z", "");
  const requestDomain = `${appName}.${env.appDomain}`;

  const requestQuery = [
    "SELECT app_id, app_version_id",
    `FROM ${database}.request_log`,
    `WHERE received_at >= parseDateTime64BestEffort(${sqlQuote(sinceIso)})`,
    `AND request_domain = ${sqlQuote(requestDomain)}`,
    "AND app_id != 0",
    "AND app_version_id != 0",
    "ORDER BY received_at DESC",
    "LIMIT 1",
    "FORMAT JSONEachRow",
  ].join("\n");
  const requestRows = (await queryLocalPlatformClickHouse(requestQuery))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { app_id?: number; app_version_id?: number },
    );

  const appFilter = requestRows[0]
    ? `app_id = ${requestRows[0].app_id} AND app_version_id = ${requestRows[0].app_version_id}`
    : null;
  const logQuery = [
    "SELECT timestamp, CAST(stream, 'String') AS stream, message",
    `FROM ${database}.app_logs`,
    `WHERE timestamp >= parseDateTime64BestEffort(${sqlQuote(sinceIso)})`,
    appFilter ? `AND ${appFilter}` : null,
    "AND stream IN ('Stdout', 'Stderr')",
    "ORDER BY timestamp ASC",
    `LIMIT ${LOCAL_PLATFORM_CLICKHOUSE_QUERY_LIMIT}`,
    "FORMAT JSONEachRow",
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
  const body = await queryLocalPlatformClickHouse(logQuery);

  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { message?: unknown })
    .map((row) => (typeof row.message === "string" ? row.message : ""))
    .filter(Boolean);

  return lines.join("\n");
}

export class LogSniff {
  private env: TestEnv;

  public constructor(env: TestEnv) {
    this.env = env;
  }

  public async assertLogsWithin(
    appName: string,
    want: string,
    withinMs: number,
    requiredHits: number = 1,
    minimumTimeoutMs: number = 0,
  ): Promise<void> {
    const start = Date.now();
    const deadline = start + withinMs;
    let latestError: Error | undefined;
    let latestHitCount = -1;
    let latestLogs = "";

    while (true) {
      try {
        latestLogs = await getAllLogs(this.env, appName, start);
        latestHitCount = countSubstrings(latestLogs, want);
        if (
          latestHitCount === requiredHits &&
          Date.now() >= start + minimumTimeoutMs
        ) {
          return;
        }
      } catch (e) {
        if (e instanceof Error) {
          latestError = e;
        }
      }

      const now = Date.now();
      if (now >= deadline) {
        const errorStr = latestError ? ` Latest error: ${latestError}.` : "";
        const hitCountStr =
          latestHitCount >= 0 ? ` Latest hit count: ${latestHitCount}.` : "";
        const logsStr = latestLogs
          ? ` Latest logs:\n${truncateFailureLogs(latestLogs)}`
          : "";

        fail(
          `failed to find substring '${want}' ${requiredHits} time(s) in app logs within ${withinMs}ms.${hitCountStr}${errorStr}${logsStr}`,
        );
      }

      await sleep(Math.min(LOG_POLL_INTERVAL_MS, deadline - now));
    }
  }
}

/***
 * getAllLogs for an environment which has a deployed app within it.
 */
export async function getAllLogs(
  env: TestEnv,
  appName: string,
  sinceMs: number = Date.now() - 15 * 60 * 1000,
): Promise<string> {
  let cliError: Error | undefined;

  try {
    const cmdResp = await env.runWasmerCommand({
      args: ["app", "logs", `${env.namespace}/${appName}`],
      quiet: true,
    });
    if (cmdResp.code != 0) {
      cliError = new Error(
        `failed to get logs for: '${appName}. Recieved status code: ${cmdResp.code}, out: ${cmdResp.stdout}, err: ${cmdResp.stderr}`,
      );
    } else if (cmdResp.stdout.trim()) {
      return cmdResp.stdout;
    }
  } catch (error) {
    cliError = error instanceof Error ? error : new Error(String(error));
  }

  if (isLocalPlatformLogFallbackEnabled()) {
    try {
      const clickhouseLogs = await getLocalPlatformLogsFromClickHouse(
        env,
        appName,
        sinceMs,
      );
      if (clickhouseLogs.trim()) {
        return clickhouseLogs;
      }
    } catch (clickhouseError) {
      if (cliError) {
        throw new Error(
          `Failed to get logs for '${appName}' via wasmer app logs (${cliError.message}) and local ClickHouse fallback (${String(clickhouseError)})`,
        );
      }
      throw clickhouseError;
    }
  }

  if (cliError) {
    throw cliError;
  }

  return "";
}
