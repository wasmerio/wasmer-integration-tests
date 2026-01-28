import * as fs from "node:fs";

import type { AppTemplate } from "../../src/backend";
import { appGetToAppInfo } from "../../src/convert";
import { createTempDir } from "../../src/fs";
import { TestEnv, randomAppName } from "../../src/index";

export type TemplateDeployOptions = {
  formatFailureOutput?: boolean;
};

export function filterTemplates(
  templates: AppTemplate[],
  allowlist?: string[],
): AppTemplate[] {
  if (!allowlist || allowlist.length === 0) {
    return templates;
  }

  const allowed = new Set(allowlist);
  const filtered = templates.filter((tpl) => allowed.has(tpl.slug));

  if (filtered.length === 0) {
    const available = templates.map((tpl) => tpl.slug).join(", ");
    throw new Error(
      `No templates matched allowlist [${allowlist.join(", ")}]. Available: ${available}`,
    );
  }

  return filtered;
}

export async function deployAndValidateTemplate(
  env: TestEnv,
  tpl: AppTemplate,
  options?: TemplateDeployOptions,
): Promise<void> {
  const appName = randomAppName();
  const tempDir = await createTempDir();
  let appId: string | null = null;

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

      const appGet = await env.wasmerAppGet(`${env.namespace}/${appName}`);
      const appInfo = appGetToAppInfo(appGet);
      appId = appInfo.id;

      await env.fetchApp(appInfo, "/");
    } catch (err) {
      if (options?.formatFailureOutput) {
        throw formatTemplateCommandError(err);
      }
      throw err;
    }
  } finally {
    if (appId) {
      await env.runWasmerCommand({
        args: ["app", "delete", appId],
      });
    }

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

  return `Command failed${code}. Last 50 lines of output:\n...\n${last}`;
}

function lastLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(-count).join("\n");
}
