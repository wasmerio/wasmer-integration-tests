import { TestEnv } from "../../src/index";
import {
  deployPostgresAppWithRegionFallback,
  postgresRegionCandidates,
} from "../utils/app-databases";
import {
  PHP_FIXTURE_DEPLOY_TIMEOUT,
  buildPhpFixtureApp,
} from "../utils/php-fixture";
import {
  assertDatabaseConnectivity,
  assertDatabaseEnvReport,
  assertFixtureContract,
  randomContractSuffix,
  targetFromUrl,
} from "../utils/fixture-contract";
import { assertUpgradeRequired, targetFromAppUrl } from "../utils/ws-contract";

// Validates the language-agnostic fixture contract (fixtures/openapi.yaml)
// against its PHP implementation (fixtures/php/fixture), served by the
// phpix engine — the production PHP runtime — in the same package shape
// production apps use.
//
// The contract assertions live in tests/utils/fixture-contract.ts and are
// implementation-agnostic — this file only owns deploying the PHP fixture
// in its three configurations (volume-only, MySQL, PostgreSQL). PHP is the
// one HTTP-only implementation: phpix does not hold upgraded WebSocket
// connections, so the asyncapi.yaml channel has no PHP suite — but the
// 426 path reservation is still asserted here.

test.concurrent(
  "php-fixture-contract-endpoints",
  async () => {
    const env = TestEnv.fromEnv();

    console.log("== Deploying the PHP fixture ==");
    const app = await env.deployApp(buildPhpFixtureApp());

    try {
      // The contract only ever sees the deployed app's URL; the PHP
      // implementation behind it is invisible to the assertions.
      const target = targetFromUrl(env, app.url, {
        appName: app.version.name,
      });
      // Deployment intent: volume-only, so the app must be cleanly DB-less.
      const report = await assertDatabaseEnvReport(target);
      expect(report.present).toEqual([]);
      await assertFixtureContract(target, {
        uniqueSuffix: randomContractSuffix(),
        checkLogs: true,
      });
      console.log("== The reserved /ws path answers 426 without upgrade ==");
      await assertUpgradeRequired(targetFromAppUrl(env, app.url));
    } finally {
      await env.deleteApp(app);
    }
  },
  PHP_FIXTURE_DEPLOY_TIMEOUT,
);

test.concurrent(
  "php-fixture-mysql-connectivity",
  async () => {
    const env = TestEnv.fromEnv();

    console.log("== Deploying the PHP fixture with a MySQL database ==");
    // Omitted engine provisions MySQL (compatibility commitment covered by
    // psql.test.ts). Pinned to a database-capable region: unpinned apps can
    // land on unhealthy Edge capacity and never become reachable.
    const candidates = await postgresRegionCandidates(env);
    const app = await env.deployApp(
      buildPhpFixtureApp({
        capabilities: { database: {} },
        ...(candidates.length > 0
          ? { locality: { regions: [candidates[0]] } }
          : {}),
      }),
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
  PHP_FIXTURE_DEPLOY_TIMEOUT,
);

test.concurrent(
  "php-fixture-postgres-connectivity",
  async () => {
    const env = TestEnv.fromEnv();

    const candidates = await postgresRegionCandidates(env);
    if (candidates.length === 0) {
      console.warn(
        "No active database-capable regions exposed by this environment; skipping PostgreSQL connectivity coverage.",
      );
      return;
    }

    console.log("== Deploying the PHP fixture with a PostgreSQL database ==");
    const { info: app } = await deployPostgresAppWithRegionFallback(
      env,
      (region) =>
        buildPhpFixtureApp({
          capabilities: { database: { engine: "postgres" } },
          locality: { regions: [region] },
        }),
      candidates,
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
  PHP_FIXTURE_DEPLOY_TIMEOUT,
);
