import { AppFetchOptions, TestEnv } from "../../src/env";
import { HEADER_PURGE_INSTANCES, pollUntil, sleep } from "../../src/index";
import { getAllLogs } from "../../src/log";

// Shared, implementation-agnostic assertions for the fixture contract
// (fixtures/openapi.yaml). The real contract is the OpenAPI spec, not any
// single fixture: each language's test file deploys its own fixture app and
// passes the resulting URL in here — the assertions only ever see the URL,
// so the implementation behind it is fully abstracted away.
//
// Each assert* function covers one contract capability and reads as a
// linear arrange-act-assert scenario. Fixtures implementing only a subset
// of the spec (e.g. the Python toolbox) call the individual functions;
// full implementations run assertFixtureContract.
//
// All assertions are idempotent per app: counters assert relative
// increments and named counters use a caller-supplied unique name, so the
// same contract can be re-validated against a long-lived deployment.

export interface FixtureContractTarget {
  env: TestEnv;
  /** Fetch a contract path (starting with /) from the target app. */
  fetch: (path: string, options?: AppFetchOptions) => Promise<Response>;
  /** App name; enables assertions that inspect platform logs. */
  appName?: string;
}

/**
 * Build a contract target from an app URL (e.g. `https://<domain>`).
 * Requests are routed via env.fetchAppUrlThroughEdge so they work on the
 * local platform too. Pass `appName` to enable log-based assertions.
 */
export function targetFromUrl(
  env: TestEnv,
  baseUrl: string,
  options?: { appName?: string },
): FixtureContractTarget {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    env,
    fetch: (path, fetchOptions) =>
      env.fetchAppUrlThroughEdge(`${base}${path}`, fetchOptions),
    appName: options?.appName,
  };
}

/**
 * Unique per-run suffix for counter names and echo paths. Lowercase letters
 * only: counter names must match `^[a-z-]+$`.
 */
export function randomContractSuffix(length = 12): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  }
  return out;
}

export const REQUIRED_DB_VARS = [
  "DB_HOST",
  "DB_NAME",
  "DB_PASSWORD",
  "DB_PORT",
  "DB_USERNAME",
];

export interface DbEnvReport {
  present: string[];
  missing: string[];
  host: string | null;
  port: string | null;
  name: string | null;
  username: string | null;
  hasPassword: boolean;
  hasDatabaseUrl: boolean;
  hasDbEngine: boolean;
}

interface ProxyResult {
  body?: string;
  error?: string;
  status_code: number;
  elapsed_time_ms: number;
}

async function getJson<T>(
  target: FixtureContractTarget,
  path: string,
): Promise<T> {
  const res = await target.fetch(path);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function getTextOk(
  target: FixtureContractTarget,
  path: string,
): Promise<string> {
  const res = await target.fetch(path);
  expect(res.status).toBe(200);
  return (await res.text()).trim();
}

/** GET / answers with the fixed greeting payload. */
export async function assertLiveness(
  target: FixtureContractTarget,
): Promise<void> {
  expect(await getJson(target, "/")).toEqual({ message: "Hello World" });
}

/**
 * GET /db-env reports exactly the injected DB_* environment: all five when
 * the app has a database capability, none otherwise. The password is only
 * ever reported as a boolean.
 */
export async function assertDatabaseEnvReport(
  target: FixtureContractTarget,
  options: { expectDatabase: boolean },
): Promise<DbEnvReport> {
  const report = await getJson<DbEnvReport>(target, "/db-env");
  if (options.expectDatabase) {
    expect(report.missing).toEqual([]);
    expect(report.present.sort()).toEqual(REQUIRED_DB_VARS);
    expect(report.hasPassword).toBe(true);
    expect(report.host).toBeTruthy();
  } else {
    expect(report.present).toEqual([]);
    expect(report.missing.sort()).toEqual(REQUIRED_DB_VARS);
    expect(report.hasPassword).toBe(false);
    expect(report.host).toBeNull();
  }
  return report;
}

/**
 * GET /results opens a real database connection from inside the app using
 * the injected credentials — `OK` with a database, the missing env vars
 * named without one.
 */
export async function assertDatabaseConnectivity(
  target: FixtureContractTarget,
  options: { expectDatabase: boolean },
): Promise<void> {
  const body = await getTextOk(target, "/results");
  if (options.expectDatabase) {
    expect(body).toBe("OK");
  } else {
    expect(body).toContain("Missing required SQL environment variables");
    for (const name of REQUIRED_DB_VARS) {
      expect(body).toContain(name);
    }
  }
}

async function counterValue(
  target: FixtureContractTarget,
  path: string,
  options?: AppFetchOptions,
): Promise<number> {
  const res = await target.fetch(path, options);
  expect(res.status).toBe(200);
  const body = (await res.text()).trim();
  expect(body).toMatch(/^\d+$/);
  return parseInt(body, 10);
}

/**
 * /inc counters increment atomically, are independent per name, reject
 * invalid names, and survive an instance restart (the volume-backed
 * durability claim). Assertions are relative to the starting value so the
 * contract can be re-run against the same app.
 */
export async function assertDurableCounters(
  target: FixtureContractTarget,
  options: { uniqueCounterName: string },
): Promise<void> {
  const initial = await counterValue(target, "/inc");
  expect(await counterValue(target, "/inc", { method: "POST" })).toBe(
    initial + 1,
  );
  expect(await counterValue(target, "/inc", { method: "POST" })).toBe(
    initial + 2,
  );
  expect(await counterValue(target, "/inc")).toBe(initial + 2);

  // A never-written counter reads as 0, and increments independently of
  // the default counter.
  const named = `/inc/${options.uniqueCounterName}`;
  expect(await counterValue(target, named)).toBe(0);
  expect(await counterValue(target, named, { method: "POST" })).toBe(1);
  expect(await counterValue(target, named)).toBe(1);
  expect(await counterValue(target, "/inc")).toBe(initial + 2);

  const badName = await target.fetch("/inc/NOT-VALID", {
    acceptStatus: (status) => status === 404,
  });
  expect(badName.status).toBe(404);
  await badName.body?.cancel();

  // Restart durability: purge the running instance and read again.
  expect(
    await counterValue(target, "/inc", {
      headers: { [HEADER_PURGE_INSTANCES]: "1" },
    }),
  ).toBe(initial + 2);
  expect(await counterValue(target, named)).toBe(1);
}

// Proxy responses are JSON by contract, but an Edge instance warming up can
// briefly answer with a non-JSON error page; retry parsing on a deadline.
async function postProxy(
  target: FixtureContractTarget,
  path: string,
  payload: unknown,
  timeoutMs = 60_000,
): Promise<ProxyResult> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    const res = await target.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    try {
      return JSON.parse(body) as ProxyResult;
    } catch (err) {
      lastError = err;
      await sleep(1000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * POST /sync and /async perform outbound requests from inside the instance
 * through the implementation's blocking and non-blocking I/O paths, and
 * report failures in-band (HTTP 200 with an error object).
 */
export async function assertOutboundHttp(
  target: FixtureContractTarget,
): Promise<void> {
  for (const path of ["/sync", "/async"]) {
    const ok = await postProxy(target, path, {
      method: "GET",
      target: "http://example.com",
      timeout_ms: 10_000,
    });
    expect(ok.error).toBeUndefined();
    expect(ok.status_code).toBe(200);
    expect(ok.body).toContain("Example Domain");
    expect(ok.elapsed_time_ms).toBeLessThanOrEqual(10_000);
  }

  for (const path of ["/sync", "/async"]) {
    // Unroutable TEST-NET-1 address: the request must fail, and the failure
    // must come back in-band.
    const failed = await postProxy(target, path, {
      method: "GET",
      target: "http://192.0.2.1/",
      timeout_ms: 2_000,
    });
    expect(failed.error).toBeTruthy();
    expect(failed.body).toBeUndefined();
    expect(failed.status_code).toBe(500);
    expect(typeof failed.elapsed_time_ms).toBe("number");
  }
}

/**
 * Unmatched paths echo the request path with the deployment's unique hash.
 * Returns the echoed path for the optional log assertion.
 */
export async function assertCatchAllEcho(
  target: FixtureContractTarget,
  options: { uniquePathSegment: string },
): Promise<string> {
  const echoPath = `spec-echo/${options.uniquePathSegment}`;
  const echo = await getJson<{ echo: string; unique_hash: string }>(
    target,
    `/${echoPath}?ignored=1`,
  );
  expect(echo.echo).toBe(echoPath);
  expect(typeof echo.unique_hash).toBe("string");
  expect(echo.unique_hash.length).toBeGreaterThan(0);
  return echoPath;
}

/**
 * Each catch-all request emits a timestamped log line that reaches the
 * platform's log pipeline. Requires a target with a known app name.
 */
export async function assertCatchAllLogging(
  target: FixtureContractTarget,
  echoPath: string,
): Promise<void> {
  const appName = target.appName;
  if (!appName) {
    throw new Error(
      "assertCatchAllLogging needs a target with an app name (targetFromAppInfo)",
    );
  }
  const logLine = new RegExp(
    `\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} - /${echoPath}`,
  );
  await pollUntil(
    async () => logLine.test(await getAllLogs(target.env, appName)),
    {
      timeoutMs: 180_000,
      intervalMs: 10_000,
      description: "catch-all log line visible in app logs",
    },
  );
}

/**
 * Validate the full contract against a target, walking every capability in
 * fixtures/openapi.yaml. `uniqueSuffix` must be fresh per run (e.g. a
 * random app name) so counter and echo assertions stay idempotent.
 */
export async function assertFixtureContract(
  target: FixtureContractTarget,
  options: {
    expectDatabase: boolean;
    uniqueSuffix: string;
    /** Assert the catch-all log line via platform logs (needs appName). */
    checkLogs?: boolean;
  },
): Promise<void> {
  console.log("== contract: liveness ==");
  await assertLiveness(target);

  console.log("== contract: database-environment ==");
  await assertDatabaseEnvReport(target, options);

  console.log("== contract: database-connectivity ==");
  await assertDatabaseConnectivity(target, options);

  console.log("== contract: durable-state ==");
  await assertDurableCounters(target, {
    uniqueCounterName: options.uniqueSuffix,
  });

  console.log("== contract: outbound-http ==");
  await assertOutboundHttp(target);

  console.log("== contract: catch-all ==");
  const echoPath = await assertCatchAllEcho(target, {
    uniquePathSegment: options.uniqueSuffix,
  });
  if (options.checkLogs) {
    console.log("== contract: catch-all logging ==");
    await assertCatchAllLogging(target, echoPath);
  }
}
