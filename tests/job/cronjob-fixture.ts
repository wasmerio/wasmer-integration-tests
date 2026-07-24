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

// After a cron-disabling change (deletion, redeploy) the schedule change
// propagates to Edge eventually, so a tick already committed before the change
// may still land. The verifiable claim is therefore "the cron stops within a
// bounded window", not "the cron stops instantly": the counter must hold still
// for a full schedule interval before the deadline. A cron that is still
// scheduled increments every interval, can never stay quiet that long, and
// hits the deadline with its observed trajectory in the error.
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
