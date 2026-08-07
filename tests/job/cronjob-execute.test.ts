import {
  buildPersistentCounterApp,
  persistentCounterIncrementCommand,
  randomAppName,
  TestEnv,
} from "../../src/index";
import { pollUntil } from "../../src/util";
import { CRON_START_TIMEOUT_MS, getCounter } from "./cronjob-fixture";

// The first cron fire can lag the deploy by minutes (scheduler config
// sync); CRON_START_TIMEOUT_MS in cronjob-fixture.ts absorbs that.

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
