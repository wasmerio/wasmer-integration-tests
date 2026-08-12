// Real app-fixture deployment through TestEnv (QA-635), loaded lazily so
// scenarios without app fixtures never touch the heavy src/ dependency tree.
// TestEnv.fromEnv() reads process.env, so the generated test-env values are
// installed there first — this process is a single-run CLI, not a library.

import { cpSync, existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { AppSource } from "./sources";
import type { DeployedApp } from "./local";

async function testEnvFrom(
  testEnv: Record<string, string>,
): Promise<import("../../src/index").TestEnv> {
  const { TestEnv } = await import("../../src/index");
  for (const [name, value] of Object.entries(testEnv)) {
    process.env[name] = value;
  }
  return TestEnv.fromEnv();
}

export async function deployAppFixture(
  fixtureName: string,
  source: AppSource,
  ctx: { scenarioDir: string; testEnv: Record<string, string> },
): Promise<DeployedApp> {
  const env = await testEnvFrom(ctx.testEnv);
  const { randomAppName } = await import("../../src/index");

  switch (source.kind) {
    case "template": {
      const appName = randomAppName();
      const dir = mkdtempSync(path.join(os.tmpdir(), "ass-app-"));
      await env.runWasmerCommand({
        args: [
          "app",
          "create",
          "--name",
          appName,
          "--non-interactive",
          "--template",
          source.slug,
          "--owner",
          env.namespace,
        ],
        cwd: dir,
      });
      await env.runWasmerCommand({
        args: [
          "deploy",
          "--owner",
          env.namespace,
          "--build-remote",
          "--non-interactive",
        ],
        cwd: dir,
      });
      const info = await env.getAppGetFromDir(dir);
      return { url: info.url, appId: info.id, dir };
    }
    case "fixture": {
      const sourceDir = path.join(ctx.scenarioDir, source.path);
      if (!existsSync(sourceDir)) {
        throw new Error(
          `app fixture "${fixtureName}": ${sourceDir} does not exist`,
        );
      }
      const dir = mkdtempSync(path.join(os.tmpdir(), "ass-app-"));
      cpSync(sourceDir, dir, { recursive: true });
      const info = await env.deployAppDir(dir);
      return { url: info.url, appId: info.id, dir };
    }
    case "package": {
      let packageIdent = source.ref;
      if (source.ref.startsWith("./")) {
        packageIdent = await env.ensurePackagePublished(
          path.join(ctx.scenarioDir, source.ref),
        );
      }
      const { AppYaml } = await import("../../src/app/construct");
      const info = await env.deployApp({
        appYaml: AppYaml.parse({
          kind: "wasmer.io/App.v0",
          package: packageIdent,
        }),
      });
      return { url: info.url, appId: info.id, dir: info.dir };
    }
    case "backup":
      throw new Error(
        `app fixture "${fixtureName}": backup: sources require BE-666 (Phase 5)`,
      );
  }
}
