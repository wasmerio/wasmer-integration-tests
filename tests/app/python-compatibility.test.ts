import path from "node:path";
import { findPackageDirs } from "../../src/fs";
import { AppInfo, sleep, TestEnv } from "../../src/index";
import { randomAppName } from "../../src/app/construct";
import { copyPackageAnonymous } from "../../src/package";
import { resolveOwner } from "../../src/wasmer_cli";

const TOOLBOX_FIXTURE_ROOT = path.join("fixtures", "python");
const TOOLBOX_FIXTURE_DIRNAME = "toolbox";
const EXAMPLE_URL = "http://example.com";
const REQUEST_TIMEOUT_MS = 5000;
const JSON_RETRY_TIMEOUT_MS = 60_000;

type RequestResult = {
  body?: string;
  error?: string;
  status_code: number;
  elapsed_time_ms: number;
};

async function postJsonWithRetry(
  env: TestEnv,
  app: AppInfo,
  path: string,
  payload: unknown,
): Promise<RequestResult> {
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < JSON_RETRY_TIMEOUT_MS) {
    const response = await env.fetchApp(app, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();

    try {
      return JSON.parse(text) as RequestResult;
    } catch (err) {
      lastError = err;
      await sleep(1000);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

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

    const syncJson = await postJsonWithRetry(env, app, "/sync", {
      method: "GET",
      target: EXAMPLE_URL,
      timeout_ms: REQUEST_TIMEOUT_MS,
    });
    expect(syncJson.error).toBeUndefined();
    expect(syncJson.status_code).toBe(200);
    expect(syncJson.body).toContain("Example Domain");
    expect(syncJson.elapsed_time_ms).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);

    const asyncJson = await postJsonWithRetry(env, app, "/async", {
      method: "GET",
      target: EXAMPLE_URL,
      timeout_ms: REQUEST_TIMEOUT_MS,
    });
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
