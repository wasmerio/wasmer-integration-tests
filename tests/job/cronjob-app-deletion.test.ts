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
// sync); CRON_START_TIMEOUT_MS in cronjob-fixture.ts absorbs that.

test.concurrent(
  "deleting an app stops its cronjob from invoking another app",
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

      await pollUntil(
        async () => ((await getCounter(env, counterApp)) > 0 ? true : false),
        {
          timeoutMs: CRON_START_TIMEOUT_MS,
          intervalMs: 5_000,
          description: "cronjob to increment the durable counter",
        },
      );

      await env.deleteApp(cronApp, { immediate: true });
      cronApp = undefined;

      await expectCounterQuiescence(env, counterApp);
    } finally {
      if (cronApp) {
        await env.deleteApp(cronApp);
      }
      await env.deleteApp(counterApp);
    }
  },
  11 * CRON_INTERVAL_MS,
);
