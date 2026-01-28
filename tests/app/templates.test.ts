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
    } catch (err) {
      throw formatTemplateCommandError(err);
    }
  } finally {
    // Clean up temp dir
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

function formatTemplateCommandError(err: unknown): Error {
  if (err instanceof Error) {
    const formatted = formatCommandFailure(err.message);
    if (formatted) {
      return new Error(formatted);
    }
    return err;
  }

  return new Error(String(err));
}

function formatCommandFailure(message: string): string | null {
  const prefix = "Command failed: ";
  if (!message.startsWith(prefix)) {
    return null;
  }

  const raw = message.slice(prefix.length);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof data !== "object" || data === null) {
    return null;
  }

  const record = data as { code?: number; stdout?: unknown; stderr?: unknown };
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  const last = lastLines(combined, 50);
  const code =
    typeof record.code === "number" ? ` (exit code ${record.code})` : "";

  if (!last.trim()) {
    return `Command failed${code}. No output captured.`;
  }

  return `Command failed${code}. Last 50 lines of output:\n${last}`;
}

function lastLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(-count).join("\n");
}
