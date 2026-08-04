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

// EDGE-1818: https://linear.app/wasmer/issue/EDGE-1818/add-integration-test-for-cronjobs-on-the-backend
// This asserts correct behavior, which is known-broken by cron
// execution/deletion lifecycle defects. Marked test.failing so the suite
// stays green while the defect persists; it turns red the moment the
// behavior starts passing — remove .failing then.
//
// Deleting an app must also delete its cronjobs from Edge. Otherwise a deleted
// app continues making requests indefinitely. This test observes those requests
// through a separate app's durable volume-backed counter.

test.failing(
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
