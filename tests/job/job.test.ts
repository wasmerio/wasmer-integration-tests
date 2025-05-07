import * as fs from "node:fs";

import {
  AppJob,
  buildPhpApp,
  JobAction,
  randomAppName,
  TestEnv,
} from "../../src/index";
import { LogSniff } from "../../src/log";

const SECOND = 1000;

async function performTest(
  jobs: AppJob[],
  logValidationStr: string,
  timeoutSec: number,
  expectLogOccurance: number = 1,
  minimumTimeoutSec: number = 0,
) {
  const env = TestEnv.fromEnv();
  const appName = randomAppName();

  const filePath = "./fixtures/php/path-logger.php";
  const phpPathLogger = await fs.promises.readFile(filePath, "utf-8");

  const spec = buildPhpApp(phpPathLogger, { name: appName });
  spec.appYaml.name = appName;
  spec.appYaml.jobs = jobs;
  // NOTE: This is added to ensure that the job only runs once. If a region
  // isn't specified, it'll run once per region, skewing the logs
  spec.appYaml.locality = {
    regions: ["be-mons"],
  };
  console.debug(JSON.stringify(spec));
  const deployedApp = await env.deployApp(spec);

  const logSniff = new LogSniff(env);
  await logSniff.assertLogsWithin(
    appName,
    logValidationStr,
    timeoutSec * SECOND,
    expectLogOccurance,
    minimumTimeoutSec,
  );

  await env.deleteApp(deployedApp);
}

test.skip("Logvalidation - Http job: post-deployment", async () => {
  await performTest(
    [
      {
        name: randomAppName(),
        trigger: "post-deployment",
        action: {
          fetch: {
            path: "/this-is-fetch-from-post-deploy-job",
            timeout: "30s",
          },
        },
      },
    ],
    "this-is-fetch-from-post-deploy-job",
    15,
  );
});

test.skip("Logvalidation - Exec job: post-deployment", async () => {
  await performTest(
    [
      {
        name: randomAppName(),
        trigger: "post-deployment",
        action: {
          execute: {
            cli_args: [
              "-r",
              "fwrite(fopen('php://stderr', 'w'), 'cronjob-exec-post-deployment');",
            ],
            command: "php",
          },
        },
      },
    ],
    "cronjob-exec-post-deployment",
    15,
  );
});

async function cronjobTest(
  name: string,
  action: JobAction,
  logValidationStr: string,
) {
  await performTest(
    [
      {
        name: name,
        trigger: "*/1 * * * *",
        action: action,
      },
    ],
    logValidationStr,
    // Timeout is quite long to take account for the initial scheduling of 1 minute,
    // and then wait for the second iteration, occuring after another minute
    130,
    2,
    // Set minimum timeout to 125 seconds, here it should have run twice
    // This is needed since we have an edge case where the fetch runs multiple times and
    // makes the test complete prematurely (and falsely: we don't know if it'll repeat,
    // and also, it shouldn't run more than once per run)
    125,
  );
}

test.skip("Logvalidation - Http cronjob: every minute", async () => {
  await cronjobTest(
    randomAppName(),
    {
      fetch: {
        path: "/this-is-fetch-from-cron-job",
        timeout: "30s",
      },
    },
    "this-is-fetch-from-cron-job",
  );
});

test.skip("Logvalidation - Exec cronjob: every minute", async () => {
  await cronjobTest(
    randomAppName(),
    {
      execute: {
        cli_args: [
          "-r",
          "fwrite(fopen('php://stderr', 'w'), 'cronjob-exec-every-1-min');",
        ],
        command: "php",
      },
    },
    "cronjob-exec-every-1-min",
  );
});
