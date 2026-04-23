import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

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

      await normalizeTemplateForLocalDeploy(env, tempDir);

      if (env.edgeServer && tpl.slug === "hono-starter") {
        await runLocalCommand("pnpm", ["install"], tempDir);
        await runLocalCommand(
          "pnpm",
          [
            "add",
            "-D",
            "vite",
            "@hono/vite-cloudflare-pages",
            "@hono/vite-dev-server",
            "typescript",
            "miniflare",
          ],
          tempDir,
        );
        await runLocalCommand("pnpm", ["exec", "vite", "build"], tempDir);
        await env.runWasmerCommand({
          args: ["deploy", "--owner", env.namespace, "--non-interactive"],
          cwd: tempDir,
        });
      } else {
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
      }

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

async function runLocalCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Command failed: ${command} ${args.join(" ")}\n${Buffer.concat(
            stdout,
          ).toString()}\n${Buffer.concat(stderr).toString()}`.trim(),
        ),
      );
    });
  });
}

async function normalizeTemplateForLocalDeploy(
  env: TestEnv,
  dir: string,
): Promise<void> {
  if (!env.edgeServer) {
    return;
  }

  const pythonVersionPath = path.join(dir, ".python-version");
  if (fs.existsSync(pythonVersionPath)) {
    const pythonVersion = (
      await fs.promises.readFile(pythonVersionPath, "utf-8")
    ).trim();
    if (pythonVersion === "3.13") {
      await fs.promises.writeFile(pythonVersionPath, "3.12\n");
    }
  }

  const pyprojectPath = path.join(dir, "pyproject.toml");
  if (fs.existsSync(pyprojectPath)) {
    const pyproject = await fs.promises.readFile(pyprojectPath, "utf-8");
    const normalized = pyproject.replace(
      /"pydantic>=([^"<]+)"/g,
      '"pydantic>=2.12.4,<2.13"',
    );
    if (normalized !== pyproject) {
      await fs.promises.writeFile(pyprojectPath, normalized);
    }
  }

  const packageJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return;
  }

  const raw = await fs.promises.readFile(packageJsonPath, "utf-8");
  const parsed = JSON.parse(raw) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    type?: string;
  };
  const preinstall = parsed.scripts?.preinstall;
  if (typeof preinstall === "string" && preinstall.includes("preinstall.js")) {
    delete parsed.scripts?.preinstall;
  }

  if (
    !parsed.scripts?.build &&
    fs.existsSync(path.join(dir, "vite.config.ts")) &&
    typeof parsed.dependencies?.hono === "string"
  ) {
    parsed.scripts = parsed.scripts ?? {};
    parsed.scripts.build = "vite build";
    parsed.type = "module";
  }

  await fs.promises.writeFile(
    packageJsonPath,
    JSON.stringify(parsed, null, 2) + "\n",
  );

  const wasmerTomlPath = path.join(dir, "wasmer.toml");
  if (fs.existsSync(wasmerTomlPath)) {
    const wasmerToml = await fs.promises.readFile(wasmerTomlPath, "utf-8");
    const normalized = wasmerToml.replace(
      /"wasmer\/winterjs"\s*=\s*"\^0\.3\.4"/g,
      '"wasmer/winterjs" = "^1"',
    );
    if (normalized !== wasmerToml) {
      await fs.promises.writeFile(wasmerTomlPath, normalized);
    }
  }
}
