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
  expectCounterQuiescence,
  getCounter,
} from "./cronjob-fixture";

// The first cron fire can lag the deploy by minutes (scheduler config
// sync); CRON_START_TIMEOUT_MS in cronjob-fixture.ts absorbs that — this
// test pays the wait twice (original action, then the replacement).

test(
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

      await expectCounterQuiescence(env, counterApp, "old");
    } finally {
      if (cronApp) await env.deleteApp(cronApp);
      await env.deleteApp(counterApp);
    }
  },
  // Two start windows (original + replaced action) + the quiescence deadline,
  // with margin for deploys and polling.
  2 * CRON_START_TIMEOUT_MS + 10 * CRON_INTERVAL_MS,
);
