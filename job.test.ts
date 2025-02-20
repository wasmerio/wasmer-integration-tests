import fs from "node:fs";
import { AppJob, JobAction, randomAppName } from "./src/app/construct.ts";
import { buildPhpApp } from "./src/app/php.ts";
import { AppInfo } from "./src/backend.ts";
import { TestEnv } from "./src/env.ts";
import { LogSniff } from "./src/log.ts";

/**
 * Tests in this file are separate to allow them to run in parallell
 */
const SECOND = 1000;

async function performTest(
  t: Deno.TestContext,
  jobs: AppJob[],
  logValidationStr: string,
  timeoutSec: number,
  expectLogOccurance: number = 1,
  minimumTimeoutSec: number = 0,
) {
  const env = TestEnv.fromEnv();
  const appName = randomAppName();
  let deployedApp: AppInfo;

  const filePath = "./src/validation-tests/path-logger.php";
  const phpPathLogger = await fs.promises.readFile(filePath, "utf-8");

  await t.step("Deploy app", async () => {
    const spec = buildPhpApp(phpPathLogger, { name: appName });
    spec.appYaml.name = appName;
    spec.appYaml.jobs = jobs;
    // NOTE: This is added to ensure that the job only runs once. If a region
    // isn't specified, it'll run once per region, skewing the logs
    spec.appYaml.locality = {
      regions: ["be-mons"],
    };
    console.debug(JSON.stringify(spec, null, " "));
    deployedApp = await env.deployApp(spec);
  });

  await t.step("check logs", async () => {
    const logSniff = new LogSniff(env);
    await logSniff.assertLogsWithin(
      appName,
      logValidationStr,
      timeoutSec * SECOND,
      expectLogOccurance,
      minimumTimeoutSec,
    );
  });

  await t.step("delete app", async () => {
    await env.deleteApp(deployedApp);
  });
}

Deno.test("Logvalidation - Http job: post-deployment", {}, async (t) => {
  await performTest(
    t,
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

Deno.test("Logvalidation - Exec job: post-deployment", {}, async (t) => {
  await performTest(
    t,
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
  t: Deno.TestContext,
  name: string,
  action: JobAction,
  logValidationStr: string,
) {
  await performTest(
    t,
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

Deno.test("Logvalidation - Http cronjob: every minute", {}, async (t) => {
  await cronjobTest(t, randomAppName(), {
    fetch: {
      path: "/this-is-fetch-from-cron-job",
      timeout: "30s",
    },
  }, "this-is-fetch-from-cron-job");
});

Deno.test("Logvalidation - Exec cronjob: every minute", {}, async (t) => {
  await cronjobTest(t, randomAppName(), {
    execute: {
      cli_args: [
        "-r",
        "fwrite(fopen('php://stderr', 'w'), 'cronjob-exec-every-1-min');",
      ],
      command: "php",
    },
  }, "cronjob-exec-every-1-min");
});
