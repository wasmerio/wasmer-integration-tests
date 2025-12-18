// Test for app templates.

import { TestEnv, randomAppName } from "../../src/index";
import * as fs from "node:fs";
import { createTempDir } from "../../src/fs";
import type { AppTemplate } from "../../src/backend";

// NOTE: The list of templates is dynamically generated in jest-global-setup.ts!
// eslint-disable-next-line @typescript-eslint/no-require-imports
const templates = require("../generated-templates.json");

describe("app templates deploy", () => {
  for (const tpl of templates) {
    test.concurrent("Template remote build: " + tpl.slug, async () => {
      const env = TestEnv.fromEnv();
      await deployAndValidateTemplate(env, tpl);
    });
  }
});

async function deployAndValidateTemplate(env: TestEnv, tpl: AppTemplate) {
  const appName = randomAppName();
  const tempDir = await createTempDir();
  console.log(
    `Testing template='${tpl.slug}', appName='${appName}', tempDir='${tempDir}'`,
  );
  try {
    // NOTE: `wasmer deploy` currently does not handle --app-name flags correctly,
    // so need to first create the app, then deploy to it.
    await env.runWasmerCommand({
      args: [
        "app",
        "create",
        "--name",
        appName,
        "--non-interactive",
        "--template",
        tpl.slug,
        "--owner",
        env.namespace,
      ],
      cwd: tempDir,
    });

    await env.runWasmerCommand({
      args: [
        "deploy",
        "--owner",
        env.namespace,
        "--build-remote",
        "--non-interactive",
      ],
      cwd: tempDir,
    });

    const appInfoOutput = await env.runWasmerCommand({
      args: ["app", "get", `${env.namespace}/${appName}`, "--format", "json"],
    });

    const appInfo = JSON.parse(appInfoOutput.stdout.trim());

    // Fetch the app URL and validate it returns 200
    await env.fetchApp(appInfo, "/");

    // Delete the app
    await env.runWasmerCommand({
      args: ["app", "delete", appInfo.id],
    });
  } finally {
    // Clean up temp dir
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}
