import { fail } from "jsr:@std/assert/fail";

import {
  AppInfo,
  AppYaml,
  ExecJob,
  loadAppYaml,
  LogSniff,
  randomAppName,
  saveAppYaml,
  SECOND,
  TestEnv,
} from "../src/index.ts";

function generateNeedlesslySecureRandomPassword(): string {
  const charset =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+~";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => charset[b % charset.length])
    .join("");
}

function randomizeJobDatabaseEnvVarsForWP(appYaml: AppYaml): void {
  if (appYaml.jobs) {
    for (const j of appYaml.jobs) {
      const execJobCheck = ExecJob.safeParse(j.action);
      if (execJobCheck.success) {
        const execJobAction = execJobCheck.data;
        const newEnvs = {
          WP_ADMIN_EMAIL: "admin@example.com",
          WP_ADMIN_PASSWORD: generateNeedlesslySecureRandomPassword(),
          WP_ADMIN_USERNAME: "admin",
          WP_SITE_TITLE: "Integration test " + Math.random(),
          WP_LOCALE: "en_US",
          AUTH_KEY: generateNeedlesslySecureRandomPassword(),
          AUTH_SALT: generateNeedlesslySecureRandomPassword(),
          LOGGED_IN_KEY: generateNeedlesslySecureRandomPassword(),
          LOGGED_IN_SALT: generateNeedlesslySecureRandomPassword(),
          NONCE_KEY: generateNeedlesslySecureRandomPassword(),
          NONCE_SALT: generateNeedlesslySecureRandomPassword(),
        };
        execJobAction.execute.env = newEnvs;
        j.action = execJobAction;
      }
    }
  }
}

/**
 * updateAppYaml by valdiating there is a local file app.yaml, then performing
 * the necessary updates to the local state in memory, then lastly overwrite the
 * app.yaml file. Returns the updated version of appYaml.
 */
function updateAppYaml(env: TestEnv): AppYaml {
  const appYaml = loadAppYaml("./");
  appYaml.name = randomAppName();
  appYaml.app_id = undefined;
  appYaml.owner = env.namespace;
  randomizeJobDatabaseEnvVarsForWP(appYaml);
  saveAppYaml("./", appYaml);
  return appYaml;
}

/**
 * Deploying a wordpress app takes too much configuration to feasibly import all of it
 * into cache. Instead, we reverse it and use wordpress as a submodule, update app.yaml
 * and then deploy. Since we update app.yaml, we still control app ID, secrets etc.
 */
Deno.test("app-wordpress", {}, async (t) => {
  const env = TestEnv.fromEnv();
  // NOTE: Instead of setting up app.yaml/deployment manually, use wordpress as submodule
  // This might force resetting the repo on local runs
  Deno.chdir("./wordpress/");
  const appYaml = updateAppYaml(env);
  console.log(appYaml);
  let appInfo: AppInfo;
  const logSniff = new LogSniff(env);

  await t.step("deploy", async () => {
    appInfo = await env.deployAppDir("./");
  });

  await t.step("validate deployment", async () => {
    await logSniff.assertLogsWithin(
      appYaml.name!,
      "WordPress installed successfully.",
      30 * SECOND,
    );
  });

  await t.step("validate autosetup", async () => {
    await logSniff.assertLogsWithin(
      appYaml.name!,
      "Installation complete",
      30 * SECOND,
    );
  });

  await t.step("validate properly setup", async () => {
    const got = await env.fetchApp(appInfo, "/");
    const body = await got.text();
    if (!got.ok) {
      fail(
        `Failed to fetch deployed wordpress app. Response not OK. Body: ${body}
\n\nFull response:${got}`,
      );
    }
    if (!body.includes("<html")) {
      fail(`Expected fetched body to include a html tag, received:\n${body}
\n\nFull response:${got}`);
    }

    if (!body.includes("WordPress")) {
      fail(
        `Expected fetched body to include substring 'WordPress', received:\n${body}
\n\nFull response:${got}`,
      );
    }
  });
});
