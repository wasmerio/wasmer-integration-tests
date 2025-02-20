import { fail } from "jsr:@std/assert/fail";
import { TestEnv } from "./src/env.ts";
import {
  AppYaml,
  EnvVars,
  ExecJob,
  randomAppName,
  SECOND,
} from "./src/app/construct.ts";
import { createHash } from "node:crypto";
import { parse } from "jsr:@std/yaml";
import { AppInfo } from "./src/backend.ts";
import { LogSniff } from "./src/log.ts";

// Assume the loadAppYaml and saveAppYaml functions are predefined
function loadAppYaml(path: string): AppYaml {
  try {
    return AppYaml.parse(parse(Deno.readTextFileSync(path + "app.yaml")));
  } catch (error) {
    if (error instanceof Error) {
      fail(`Failed to load AppYaml from ${path}: ${error.message}`);
    } else {
      throw error;
    }
  }
}

function saveAppYaml(path: string, appYaml: AppYaml): void {
  try {
    Deno.writeTextFileSync(path + "app.yaml", JSON.stringify(appYaml, null, 2));
  } catch (error) {
    if (error instanceof Error) {
      fail(`Failed to save AppYaml to ${path}: ${error.message}`);
    } else {
      throw error;
    }
  }
}

function generateNeedlesslySecureRandomPassword(): string {
  const charset =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+~";
  let password = "";
  for (let i = 0; i < 16; i++) {
    const crypto = createHash("sha256");
    const randomIndex = crypto.digest()[0] %
      charset.length;
    password += charset[randomIndex];
  }
  return password;
}

function randomizeDatabaseVarsEnvVars(appYaml: AppYaml): void {
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
        };
        execJobAction.execute.env = EnvVars.parse(newEnvs);
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
  randomizeDatabaseVarsEnvVars(appYaml);
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
  let appInfo: AppInfo;
  const logSniff = new LogSniff(env);

  await t.step("deploy", async () => {
    appInfo = await env.deployAppDir("./");
  });

  await t.step("validate deployment", async () => {
    await logSniff.assertLogsWithin(
      appYaml.name!,
      "Installation complete",
      60 * SECOND,
    );

    const got = await env.fetchApp(appInfo, "/");
    if (!got.ok) {
      fail(`Failed to fetch deployed wordpress app: ${await got.text()}`);
    }
  });
});
