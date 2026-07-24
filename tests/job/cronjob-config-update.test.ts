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
// Redeploying a changed cronjob must replace its prior action. Separate durable
// counters make both the new action and the absence of the old action observable.

test.concurrent(
  "a cronjob config update replaces its prior fetch action",
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
            name: "increment-old-counter",
            trigger: "* * * * *",
            action: {
              fetch: {
                path: `${counterApp.url}${persistentCounterIncrementPath("old")}`,
                method: "POST",
                timeout: "30s",
              },
            },
          },
        ]),
      );
      await pollUntil(
        async () =>
          (await getCounter(env, counterApp, "old")) > 0 ? true : false,
        {
          timeoutMs: CRON_START_TIMEOUT_MS,
          intervalMs: 5_000,
          description: "original cronjob action to increment its counter",
        },
      );

      cronApp = await env.deployApp(
        buildCronApp(cronName, [
          {
            name: "increment-new-counter",
            trigger: "* * * * *",
            action: {
              fetch: {
                path: `${counterApp.url}${persistentCounterIncrementPath("new")}`,
                method: "POST",
                timeout: "30s",
              },
            },
          },
        ]),
      );
      await pollUntil(
        async () =>
          (await getCounter(env, counterApp, "new")) > 0 ? true : false,
        {
          timeoutMs: CRON_START_TIMEOUT_MS,
          intervalMs: 5_000,
          description: "updated cronjob action to increment its counter",
        },
      );

      const oldCount = await getCounter(env, counterApp, "old");
      const oldCounts = await observeCounter(
        env,
        counterApp,
        CRON_INTERVAL_MS,
        "old",
      );
      expect(oldCounts).toEqual(Array(oldCounts.length).fill(oldCount));
    } finally {
      if (cronApp) await env.deleteApp(cronApp);
      await env.deleteApp(counterApp);
    }
  },
  8 * CRON_INTERVAL_MS,
);
