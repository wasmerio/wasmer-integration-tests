import {
  AppYaml,
  ExecJob,
  loadAppYaml,
  LogSniff,
  randomAppName,
  saveAppYaml,
  SECOND,
  TestEnv,
} from "../../src/index";
import { generateNeedlesslySecureRandomPassword } from "../../src/security";
import { validateWordpressIsLive } from "../../src/wordpress";


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
test("app-wordpress", async () => {
  const env = TestEnv.fromEnv();
  // NOTE: Instead of setting up app.yaml/deployment manually, use wordpress as submodule
  // This might force resetting the repo on local runs
  process.chdir("./wordpress")
  const appYaml = updateAppYaml(env);
  const logSniff = new LogSniff(env);

  const appInfo = await env.deployAppDir("./");

  await logSniff.assertLogsWithin(
    appYaml.name!,
    "WordPress installed successfully.",
    60 * SECOND,
  );

  console.log("Validating app: ", appInfo!.url);

  await validateWordpressIsLive(appInfo!.url);
  await env.deleteApp(appInfo!);
});
