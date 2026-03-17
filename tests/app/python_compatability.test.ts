import path from "node:path";
import { findPackageDirs } from "../../src/fs";
import { AppInfo, TestEnv } from "../../src/index";
import { randomAppName } from "../../src/app/construct";
import { copyPackageAnonymous } from "../../src/package";
import { resolveOwner } from "../../src/wasmer_cli";

const TOOLBOX_FIXTURE_ROOT = path.join("fixtures", "python");
const TOOLBOX_FIXTURE_DIRNAME = "toolbox";
const EXAMPLE_URL = "http://example.com";
const REQUEST_TIMEOUT_MS = 5000;

test.concurrent("async python timing out", async () => {
  const env = TestEnv.fromEnv();
  const owner = resolveOwner(env);
  const pkgDirs = findPackageDirs(TOOLBOX_FIXTURE_ROOT);
  const toolboxDir = pkgDirs.find(
    (dir) => path.basename(dir) === TOOLBOX_FIXTURE_DIRNAME,
  );

  expect(toolboxDir).toBeDefined();

  const workDir = await copyPackageAnonymous(toolboxDir!);
  let app: AppInfo | undefined;

  try {
    app = await env.deployAppDir(workDir, {
      extraCliArgs: [
        "--build-remote",
        "--owner",
        owner,
        "--app-name",
        randomAppName(),
      ],
    });

    const syncResponse = await env.fetchApp(app, "/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "GET",
        target: EXAMPLE_URL,
        timeout_ms: REQUEST_TIMEOUT_MS,
      }),
    });
    const syncJson = (await syncResponse.json()) as {
      body?: string;
      error?: string;
      status_code: number;
      elapsed_time_ms: number;
    };
    expect(syncJson.error).toBeUndefined();
    expect(syncJson.status_code).toBe(200);
    expect(syncJson.body).toContain("Example Domain");
    expect(syncJson.elapsed_time_ms).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);

    const asyncResponse = await env.fetchApp(app, "/async", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "GET",
        target: EXAMPLE_URL,
        timeout_ms: REQUEST_TIMEOUT_MS,
      }),
    });
    const asyncJson = (await asyncResponse.json()) as {
      body?: string;
      error?: string;
      status_code: number;
      elapsed_time_ms: number;
    };
    expect(asyncJson.error).toBeUndefined();
    expect(asyncJson.status_code).toBe(200);
    expect(asyncJson.body).toContain("Example Domain");
    expect(asyncJson.elapsed_time_ms).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
  } finally {
    if (app) {
      await env.deleteApp(app);
    }
  }
});
