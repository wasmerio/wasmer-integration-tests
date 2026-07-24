import {
  buildPersistentCounterApp,
  persistentCounterIncrementPath,
  randomAppName,
  TestEnv,
} from "../../src/index";
import { pollUntil } from "../../src/util";
import {
  buildCronApp,
  CRON_INTERVAL_MS,
  CRON_START_TIMEOUT_MS,
  getCounter,
  observeCounter,
} from "./cronjob-fixture";

// EDGE-1818: https://linear.app/wasmer/issue/EDGE-1818/add-integration-test-for-cronjobs-on-the-backend
// This asserts correct behavior and may remain red until known cron
// execution/deletion lifecycle defects are fixed; coordinate on the ticket
// rather than skipping or quarantining this test.
//
// Removing jobs from an app configuration must stop scheduling them while the
// app itself continues serving traffic. A separate app stores the durable proof.

test.concurrent(
  "removing a cronjob from config stops it without deleting its app",
  async () => {
    const env = TestEnv.fromEnv();
    const counterApp = await env.deployApp(
      buildPersistentCounterApp({ name: randomAppName() }),
    );
    const cronName = randomAppName();
    let cronApp: Awaited<ReturnType<typeof env.deployApp>> | undefined;

    try {
      cronApp = await env.deployApp(
        buildCronApp(cronName, [
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
      await pollUntil(
        async () => ((await getCounter(env, counterApp)) > 0 ? true : false),
        {
          timeoutMs: CRON_START_TIMEOUT_MS,
          intervalMs: 5_000,
          description: "configured cronjob to increment the durable counter",
        },
      );

      cronApp = await env.deployApp(buildCronApp(cronName, []));
      expect((await env.fetchApp(cronApp, "/")).status).toBe(204);

      const count = await getCounter(env, counterApp);
      const counts = await observeCounter(env, counterApp, CRON_INTERVAL_MS);
      expect(counts).toEqual(Array(counts.length).fill(count));
    } finally {
      if (cronApp) await env.deleteApp(cronApp);
      await env.deleteApp(counterApp);
    }
  },
  6 * CRON_INTERVAL_MS,
);
