import { AppInfo, TestEnv, randomAppName } from "../../src/index";
import {
  NO_PSQL_CONFIG_RE,
  postgresRegionCandidates,
} from "../utils/app-databases";
import {
  PYTHON_REMOTE_BUILD_TIMEOUT,
  deployPythonFixture,
  preparePythonFixtureDir,
} from "../utils/python-fixture";
import {
  assertDatabaseConnectivity,
  assertDatabaseEnvReport,
  assertFixtureContract,
  randomContractSuffix,
  targetFromUrl,
} from "../utils/fixture-contract";

// Validates the language-agnostic fixture contract (fixtures/openapi.yaml)
// against its Python implementation (fixtures/python/toolbox), deployed
// through the remote-build (Anybuild) pipeline from the FastAPI sources.
//
// The contract assertions live in tests/utils/fixture-contract.ts and are
// implementation-agnostic — this file only owns deploying the Python
// fixture in its three configurations (volume-only, MySQL, PostgreSQL).
// Database connectivity is asserted *from inside the app* (/results) via
// the pure-Python pg8000/PyMySQL drivers.

test.concurrent(
  "python-fixture-contract-endpoints",
  async () => {
    const env = TestEnv.fromEnv();

    console.log("== Deploying the Python fixture via remote build ==");
    const app = await deployPythonFixture(
      env,
      `volumes:
  - name: data
    mount: /data
`,
    );

    try {
      // The contract only ever sees the deployed app's URL; the Python
      // implementation behind it is invisible to the assertions.
      const target = targetFromUrl(env, app.url, {
        appName: app.version.name,
      });
      // Deployment intent: the app.yaml requests no database, but anybuild's
      // python provider auto-provisions MySQL because `pymysql` (needed by
      // /results) is in pyproject (`detect_database` over MYSQL_DEPS in
      // anybuild providers/python.rs) — and `python_database` has no value
      // that disables detection. So this deployment *does* carry injected
      // credentials, and the contract requires them to actually work.
      const report = await assertDatabaseEnvReport(target);
      expect(report.missing).toEqual([]);
      await assertFixtureContract(target, {
        uniqueSuffix: randomContractSuffix(),
        checkLogs: true,
      });
    } finally {
      await env.deleteApp(app);
    }
  },
  PYTHON_REMOTE_BUILD_TIMEOUT,
);

test.concurrent(
  "python-fixture-mysql-connectivity",
  async () => {
    const env = TestEnv.fromEnv();

    console.log("== Deploying the Python fixture with a MySQL database ==");
    // Omitted engine provisions MySQL (compatibility commitment covered by
    // psql.test.ts). Pinned to a database-capable region: unpinned apps can
    // land on unhealthy Edge capacity and never become reachable.
    const candidates = await postgresRegionCandidates(env);
    const app = await deployPythonFixture(
      env,
      `capabilities:
  database: {}
${candidates.length > 0 ? `locality:\n  regions:\n    - ${candidates[0]}\n` : ""}`,
    );

    try {
      const target = targetFromUrl(env, app.url);
      // Deployment intent: a database capability was requested, so the
      // credentials must actually be injected.
      const report = await assertDatabaseEnvReport(target);
      expect(report.missing).toEqual([]);
      console.log("== The app must reach its database from the inside ==");
      await assertDatabaseConnectivity(target);
    } finally {
      await env.deleteApp(app);
    }
  },
  PYTHON_REMOTE_BUILD_TIMEOUT,
);

test.concurrent(
  "python-fixture-postgres-connectivity",
  async () => {
    const env = TestEnv.fromEnv();

    const candidates = await postgresRegionCandidates(env);
    if (candidates.length === 0) {
      console.warn(
        "No active database-capable regions exposed by this environment; skipping PostgreSQL connectivity coverage.",
      );
      return;
    }

    console.log(
      "== Deploying the Python fixture with a PostgreSQL database ==",
    );
    // Region fallback mirrors deployPostgresAppWithRegionFallback, which only
    // supports AppDefinition specs; this deploy goes through a directory.
    let app: AppInfo | undefined;
    for (const region of candidates) {
      const appName = randomAppName();
      const dir = await preparePythonFixtureDir(
        env,
        appName,
        `capabilities:
  database:
    engine: postgres
locality:
  regions:
    - ${region}
`,
      );
      try {
        app = await env.deployAppDir(dir, {
          extraCliArgs: ["--build-remote"],
        });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!NO_PSQL_CONFIG_RE.test(message)) {
          throw error;
        }
        console.warn(
          `Region ${region} has no PostgreSQL config; trying the next candidate.`,
        );
        await env.runWasmerCommand({
          args: ["app", "delete", `${env.namespace}/${appName}`],
          noAssertSuccess: true,
          quiet: true,
        });
      }
    }
    if (!app) {
      throw new Error(
        `No candidate region has a PostgreSQL database config (tried: ${candidates.join(", ")})`,
      );
    }

    try {
      const target = targetFromUrl(env, app.url);
      // Deployment intent: a database capability was requested, so the
      // credentials must actually be injected.
      const report = await assertDatabaseEnvReport(target);
      expect(report.missing).toEqual([]);
      console.log("== The app must reach its database from the inside ==");
      await assertDatabaseConnectivity(target);
    } finally {
      await env.deleteApp(app);
    }
  },
  PYTHON_REMOTE_BUILD_TIMEOUT,
);
