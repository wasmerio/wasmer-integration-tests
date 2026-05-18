import { fail } from "node:assert";

import { TestEnv } from "./env";
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

function truncateFailureLogs(logs: string): string {
  if (process.env.VERBOSE === "true") {
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
        latestLogs = await getAllLogs(this.env, appName);
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
): Promise<string> {
  const cmdResp = await env.runWasmerCommand({
    args: ["app", "logs", `wasmer-integration-tests/${appName}`],
    quiet: true,
  });
  if (cmdResp.code != 0) {
    throw new Error(
      `failed to get logs for: '${appName}. Recieved status code: ${cmdResp.code}, out: ${cmdResp.stdout}, err: ${cmdResp.stderr}`,
    );
  }
  return cmdResp.stdout;
}
