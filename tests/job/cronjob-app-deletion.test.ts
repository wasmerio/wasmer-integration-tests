import type { AppInfo } from "../../src/backend";
import { buildPhpApp, randomAppName, TestEnv } from "../../src/index";
import { pollUntil, sleep } from "../../src/util";

// Deleting an app must also delete its cronjobs from Edge. Otherwise a deleted
// app continues making requests indefinitely. This test observes those requests
// through a separate app's durable volume-backed counter.

const CRON_INTERVAL_MS = 60_000;
const CRON_START_TIMEOUT_MS = 3 * CRON_INTERVAL_MS;

const counterAppCode = `<?php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path !== '/inc') {
    http_response_code(404);
    exit;
}

$counter = fopen('/data/cronjob-counter', 'c+');
if (!$counter || !flock($counter, LOCK_EX)) {
    http_response_code(500);
    exit;
}
rewind($counter);
$value = (int) stream_get_contents($counter);
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $value++;
    ftruncate($counter, 0);
    rewind($counter);
    fwrite($counter, (string) $value);
    fflush($counter);
}
flock($counter, LOCK_UN);
fclose($counter);
header('Content-Type: text/plain');
echo $value;
`;

async function getCounter(env: TestEnv, counterApp: AppInfo): Promise<number> {
  const response = await env.fetchApp(counterApp, "/inc");
  const body = await response.text();
  const value = Number.parseInt(body, 10);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Counter response was not an integer: ${body}`);
  }
  return value;
}

test(
  "deleting an app stops its cronjob from invoking another app",
  async () => {
    const env = TestEnv.fromEnv();
    const counterSpec = buildPhpApp(counterAppCode, {
      name: randomAppName(),
      volumes: [{ name: "data", mount: "/data" }],
    });
    const counterApp = await env.deployApp(counterSpec);
    let cronApp: Awaited<ReturnType<typeof env.deployApp>> | undefined;

    try {
      const cronSpec = buildPhpApp("<?php http_response_code(204);", {
        name: randomAppName(),
        jobs: [
          {
            name: "increment-counter",
            trigger: "* * * * *",
            action: {
              fetch: {
                path: `${counterApp.url}/inc`,
                method: "POST",
                timeout: "30s",
              },
            },
          },
        ],
      });
      cronApp = await env.deployApp(cronSpec);

      await pollUntil(
        async () => ((await getCounter(env, counterApp)) > 0 ? true : false),
        {
          timeoutMs: CRON_START_TIMEOUT_MS,
          intervalMs: 5_000,
          description: "cronjob to increment the durable counter",
        },
      );

      const counterBeforeDeletion = await getCounter(env, counterApp);
      await env.deleteApp(cronApp, { immediate: true });
      cronApp = undefined;

      await sleep(2 * CRON_INTERVAL_MS);
      expect(await getCounter(env, counterApp)).toBe(counterBeforeDeletion);
    } finally {
      if (cronApp) {
        await env.deleteApp(cronApp);
      }
      await env.deleteApp(counterApp);
    }
  },
  7 * CRON_INTERVAL_MS,
);
