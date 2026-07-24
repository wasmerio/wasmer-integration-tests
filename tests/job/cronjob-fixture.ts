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

// A negative cronjob assertion must cover a complete schedule interval. Polling
// keeps checking the durable state during that interval instead of sleeping once.
export async function observeCounter(
  env: TestEnv,
  counterApp: AppInfo,
  durationMs: number,
  name = "counter",
): Promise<number[]> {
  const values: number[] = [];
  const deadline = Date.now() + durationMs;
  do {
    values.push(await getCounter(env, counterApp, name));
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await sleep(Math.min(5_000, remaining));
    }
  } while (Date.now() < deadline);
  return values;
}
