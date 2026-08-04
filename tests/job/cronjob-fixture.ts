import type { AppInfo } from "../../src/backend";
import {
  AppJob,
  buildPhpApp,
  persistentCounterPath,
  TestEnv,
} from "../../src/index";
import { sleep } from "../../src/util";

export const CRON_INTERVAL_MS = 60_000;
export const CRON_START_TIMEOUT_MS = 3 * CRON_INTERVAL_MS;
export const CRON_STOP_TIMEOUT_MS = 5 * CRON_INTERVAL_MS;

export function buildCronApp(name: string, jobs: AppJob[]) {
  return buildPhpApp("<?php http_response_code(204);", { name, jobs });
}

export async function getCounter(
  env: TestEnv,
  counterApp: AppInfo,
  name = "counter",
): Promise<number> {
  const response = await env.fetchApp(counterApp, persistentCounterPath(name));
  const body = await response.text();
  const value = Number.parseInt(body, 10);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Counter response was not an integer: ${body}`);
  }
  return value;
}

// Schedule changes propagate to Edge eventually, so the claim is "stops within
// a bounded window": the counter must hold still for a full interval.
export async function expectCounterQuiescence(
  env: TestEnv,
  counterApp: AppInfo,
  name = "counter",
  quietWindowMs = CRON_INTERVAL_MS + 15_000,
  deadlineMs = CRON_STOP_TIMEOUT_MS,
): Promise<void> {
  const start = Date.now();
  let last = await getCounter(env, counterApp, name);
  let quietSince = start;
  const trajectory = [`${last}@0s`];
  for (;;) {
    await sleep(5_000);
    const value = await getCounter(env, counterApp, name);
    const now = Date.now();
    if (value !== last) {
      trajectory.push(`${value}@${Math.round((now - start) / 1000)}s`);
      last = value;
      quietSince = now;
    }
    if (now - quietSince >= quietWindowMs) {
      return;
    }
    if (now - start >= deadlineMs) {
      throw new Error(
        `Counter "${name}" of app ${counterApp.url} never went quiet for ` +
          `${quietWindowMs}ms within ${deadlineMs}ms: the cronjob is still ` +
          `being invoked. Observed values: ${trajectory.join(", ")}`,
      );
    }
  }
}
