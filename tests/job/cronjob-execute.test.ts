import {
  buildPersistentCounterApp,
  persistentCounterIncrementCommand,
  randomAppName,
  TestEnv,
} from "../../src/index";
import { pollUntil } from "../../src/util";
import { CRON_START_TIMEOUT_MS, getCounter } from "./cronjob-fixture";

// EDGE-1818: https://linear.app/wasmer/issue/EDGE-1818/add-integration-test-for-cronjobs-on-the-backend
// This asserts correct behavior and may remain red until known cron
// execution/deletion lifecycle defects are fixed; coordinate on the ticket
// rather than skipping or quarantining this test.
//
// A scheduled execute action must run in the app's mounted volume. Its PHP
// command increments a volume-backed counter that the HTTP app exposes.

test.concurrent(
  "a cronjob execute action increments its durable counter",
  async () => {
    const env = TestEnv.fromEnv();
    let app: Awaited<ReturnType<typeof env.deployApp>> | undefined;

    try {
      app = await env.deployApp(
        buildPersistentCounterApp({
          name: randomAppName(),
          jobs: [
            {
              name: "increment-counter",
              trigger: "* * * * *",
              action: {
                execute: {
                  command: "php",
                  cli_args: ["-r", persistentCounterIncrementCommand()],
                },
              },
            },
          ],
        }),
      );

      const count = await pollUntil(
        async () => {
          const value = await getCounter(env, app);
          return value > 0 ? value : false;
        },
        {
          timeoutMs: CRON_START_TIMEOUT_MS,
          intervalMs: 5_000,
          description: "execute cronjob to increment its durable counter",
        },
      );
      expect(count).toBeGreaterThanOrEqual(1);
    } finally {
      if (app) await env.deleteApp(app);
    }
  },
  4 * CRON_START_TIMEOUT_MS,
);
