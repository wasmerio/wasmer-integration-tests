import {
  buildPersistentCounterApp,
  persistentCounterIncrementPath,
  randomAppName,
  TestEnv,
} from "../../src/index";
import { pollUntil } from "../../src/util";
import {
  buildCronApp,
  CRON_START_TIMEOUT_MS,
  getCounter,
} from "./cronjob-fixture";

// EDGE-1818: https://linear.app/wasmer/issue/EDGE-1818/add-integration-test-for-cronjobs-on-the-backend
// This asserts correct behavior and may remain red until known cron
// execution/deletion lifecycle defects are fixed; coordinate on the ticket
// rather than skipping or quarantining this test.
//
// A scheduled fetch must reach its target. The target records requests in a
// volume-backed counter so the assertion survives process and log delivery.

test.concurrent(
  "a cronjob fetch increments a durable counter in its target app",
  async () => {
    const env = TestEnv.fromEnv();
    const counterApp = await env.deployApp(
      buildPersistentCounterApp({ name: randomAppName() }),
    );
    let cronApp: Awaited<ReturnType<typeof env.deployApp>> | undefined;

    try {
      cronApp = await env.deployApp(
        buildCronApp(randomAppName(), [
          {
            name: "increment-counter",
            trigger: "* * * * *",
            action: {
              fetch: {
                path: `${counterApp.url}${persistentCounterIncrementPath()}`,
                method: "POST",
                timeout: "30s",
              },
            },
          },
        ]),
      );

      const count = await pollUntil(
        async () => {
          const value = await getCounter(env, counterApp);
          return value > 0 ? value : false;
        },
        {
          timeoutMs: CRON_START_TIMEOUT_MS,
          intervalMs: 5_000,
          description: "fetch cronjob to increment the durable counter",
        },
      );
      expect(count).toBeGreaterThanOrEqual(1);
    } finally {
      if (cronApp) await env.deleteApp(cronApp);
      await env.deleteApp(counterApp);
    }
  },
  4 * CRON_START_TIMEOUT_MS,
);
