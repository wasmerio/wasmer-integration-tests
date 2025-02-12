import { fail } from "node:assert";
import { TestEnv } from "./env.ts";
import { resolve } from "node:path";

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
    const t0 = new Date().getTime();
    let resolveTest: (value: void | PromiseLike<void>) => void;
    const p = new Promise<void>((resolveMe) => {
      if (resolve != null) {
        resolveTest = resolveMe;
      }
    });
    let latestError: Error;
    const intervalID = setInterval(
      async () => {
        const now = new Date().getTime();
        const overMinimumTimeframe = now > (t0 + minimumTimeoutMs);
        const overTestTimeout = now > (t0 + withinMs);
        let amSubstrings = -1;
        let allLogs = "";
        try {
          allLogs = await getAllLogs(this.env, appName);
          amSubstrings = countSubstrings(allLogs, want);
          if (
            amSubstrings === requiredHits &&
            overMinimumTimeframe
          ) {
            clearInterval(intervalID);
            resolveTest();
            return;
          }
        } catch (e) {
          if (e instanceof Error) {
            latestError = e;
          }
        }

        if (overTestTimeout) {
          const errorStr = latestError ? ` Latest error: ${latestError}.` : "";
          const amSubstringsStr = amSubstrings > 0
            ? `Latest amSubstrings: ${amSubstrings}.`
            : "";
          // Wrap the allLogs print with newlines to make it easier to read
          allLogs = allLogs !== "" ? `\n${allLogs}` : "";

          fail(
            `failed to find any substring: '${want}' from the apps logs within: ${withinMs}ms.${amSubstringsStr}${errorStr} Latest logs:${allLogs}`,
          );
        }
      },
      3000,
    );
    await p;
  }
}

/***
 * getAllLogs for an environment which has a deployed app within it.
 */
export async function getAllLogs(
  env: TestEnv,
  appName: string,
): Promise<string> {
  const cmdResp = await env.runWasmerCommand(
    {
      args: ["app", "logs", `wasmer-integration-tests/${appName}`],
    },
  );
  if (cmdResp.code != 0) {
    throw new Error(
      `failed to get logs for: '${appName}. Recieved status code: ${cmdResp.code}, out: ${cmdResp.stdout}, err: ${cmdResp.stderr}`,
    );
  }
  return cmdResp.stdout;
}
