import { promises as fs } from "node:fs";
import path from "node:path";

import {
  AppYaml,
  createTempDir,
  ExecJob,
  loadAppYaml,
  LogSniff,
  markCurrentJestTestFailed,
  randomAppName,
  saveAppYaml,
  SECOND,
  TestEnv,
  type AppInfo,
} from "../../src/index";
import { generateNeedlesslySecureRandomPassword } from "../../src/security";
import { validateWordpressIsLive } from "../../src/wordpress";

function wordpressJobEnvVars(): Record<string, string> {
  return {
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
}

function randomizeJobDatabaseEnvVarsForWP(appYaml: AppYaml): void {
  if (!appYaml.jobs) {
    return;
  }

  for (const j of appYaml.jobs) {
    const execJobCheck = ExecJob.safeParse(j.action);
    if (!execJobCheck.success) {
      continue;
    }

    const execJobAction = execJobCheck.data;
    if (!execJobAction.execute.env?.WP_ADMIN_EMAIL) {
      continue;
    }

    execJobAction.execute.env = wordpressJobEnvVars();
    j.action = execJobAction;
  }
}

async function copyWordpressFixture(): Promise<string> {
  const dir = await createTempDir();
  await fs.cp(path.join(process.cwd(), "wordpress"), dir, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      return name !== ".git" && name !== ".jest-deployed-apps.jsonl";
    },
  });
  return dir;
}

/**
 * updateAppYaml by validating there is a local file app.yaml, then performing
 * the necessary updates to the local state in memory, then lastly overwrite the
 * app.yaml file. Returns the updated version of appYaml.
 */
function updateAppYaml(env: TestEnv, dir: string): AppYaml {
  const appYaml = loadAppYaml(dir);
  appYaml.name = randomAppName();
  appYaml.app_id = undefined;
  appYaml.owner = env.namespace;
  randomizeJobDatabaseEnvVarsForWP(appYaml);
  saveAppYaml(dir, appYaml);
  return appYaml;
}

/**
 * Deploying a wordpress app takes too much configuration to feasibly import all of it
 * into cache. Instead, we reverse it and use wordpress as a submodule, update app.yaml
 * and then deploy. Since we update app.yaml, we still control app ID, secrets etc.
 */
test("app-wordpress", async () => {
  const env = TestEnv.fromEnv();
  // NOTE: Instead of setting up app.yaml/deployment manually, use wordpress as submodule.
  // Copy it first so local test runs don't dirty the repository app.yaml.
  const dir = await copyWordpressFixture();
  const appYaml = updateAppYaml(env, dir);
  const logSniff = new LogSniff(env);

  let appInfo: AppInfo | null = null;

  try {
    appInfo = await env.deployAppDir(dir);

    await logSniff.assertLogsWithin(
      appYaml.name!,
      "Installation complete",
      180 * SECOND,
    );

    console.log("Validating app: ", appInfo.url);

    await validateWordpressIsLive(env, appInfo.url);
  } catch (err) {
    if (appInfo) {
      markCurrentJestTestFailed();
    }
    throw err;
  } finally {
    if (appInfo) {
      await env.deleteApp(appInfo);
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
