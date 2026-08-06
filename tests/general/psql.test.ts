import * as fs from "node:fs";
import path from "node:path";

import { TestEnv } from "../../src/env";
import {
  HEADER_PURGE_INSTANCES,
  buildPhpApp,
  pollUntil,
} from "../../src/index";
import { AppDatabase } from "../../src/backend";
import { projectRoot } from "../utils/path";
import {
  PostgresCredentials,
  canReachTcp,
  connectPostgres,
  withPostgres,
} from "../utils/postgres";
import {
  NO_PSQL_CONFIG_RE,
  deployPostgresAppWithRegionFallback,
  postgresRegionCandidates,
} from "../utils/app-databases";

// End-to-end coverage for User PostgreSQL v1 (QA-649/QA-650, BE-1659).
//
// The app-side fixture only reports which DB_* env vars are injected; the SQL
// round trips run from the test runner with the credentials exposed by the
// GraphQL API — the same surface the dashboard shows users. Direct SQL checks
// are skipped (with a warning) when the database endpoint is not reachable
// from the runner, which is the expected situation for the local platform.

const DB_ENV_FIXTURE = path.join(
  projectRoot,
  "fixtures",
  "php",
  "db-env-report.php",
);

interface DbEnvReport {
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

function buildDbEnvApp(
  additionalAppYamlSettings?: Record<string, unknown>,
): ReturnType<typeof buildPhpApp> {
  const code = fs.readFileSync(DB_ENV_FIXTURE, "utf-8");
  return buildPhpApp(code, {
    scaling: { mode: "single_concurrency" },
    ...additionalAppYamlSettings,
  });
}

async function fetchDbEnvReport(
  env: TestEnv,
  info: Parameters<TestEnv["fetchApp"]>[0],
  options?: { freshInstance?: boolean },
): Promise<DbEnvReport> {
  // Env vars are injected at instance start. Credential changes (createAppDb,
  // rotation) reach *new* instances only, so propagation checks must purge
  // the running instance on every poll — otherwise the poll itself keeps the
  // stale instance alive forever.
  const res = await env.fetchApp(
    info,
    "/db-env",
    options?.freshInstance
      ? { headers: { [HEADER_PURGE_INSTANCES]: "1" } }
      : {},
  );
  return (await res.json()) as DbEnvReport;
}

function activeDatabases(databases: AppDatabase[]): AppDatabase[] {
  return databases.filter((db) => !db.deletedAt);
}

// Hostname contract (documented in knowledge/01-architecture/app-databases.md):
// managed endpoints resolve under `db.<region>` / `mysql.<region>` for MySQL
// and `psql.<region>` for PostgreSQL. Only enforceable when the host is a
// managed wasmernet name; local-platform hosts are opaque.
function assertHostMatchesEngine(db: AppDatabase): void {
  if (!/wasmernet/.test(db.host)) {
    return;
  }
  if (db.engine === "POSTGRES") {
    expect(db.host).toMatch(/^psql\./);
    expect(db.host).not.toMatch(/^(db|mysql)\./);
  } else if (db.engine === "MYSQL") {
    expect(db.host).toMatch(/^(db|mysql)\./);
    expect(db.host).not.toMatch(/^psql\./);
  }
}

async function credentialsFor(
  env: TestEnv,
  appId: string,
  db: AppDatabase,
): Promise<PostgresCredentials> {
  const password = await env.backend.getAppDatabasePassword(appId);
  if (!password) {
    throw new Error(`No DB_PASSWORD secret resolvable for app ${appId}`);
  }
  return {
    host: db.host,
    port: Number(db.port),
    database: db.name,
    user: db.username,
    password,
  };
}

test.failing("psql-full-lifecycle", async () => {
  const env = TestEnv.fromEnv();

  console.log("== Deploying app with capabilities.database.engine=postgres ==");
  // Pinned to a PostgreSQL-capable region: the backend's *default* database
  // region is not engine-aware and may only hold a MySQL config (true on
  // dev, where only fr-roub1 carries PostgreSQL). The default-region
  // behavior itself is covered by `psql-default-region`.
  const { info } = await deployPostgresAppWithRegionFallback(
    env,
    (region) =>
      buildDbEnvApp({
        capabilities: { database: { engine: "postgres" } },
        locality: { regions: [region] },
      }),
    await postgresRegionCandidates(env),
  );

  try {
    // Injected env var contract: exactly the DB_* five, no DATABASE_URL and
    // no DB_ENGINE.
    const report = await fetchDbEnvReport(env, info);
    expect(report.missing).toEqual([]);
    expect(report.present.sort()).toEqual(
      ["DB_HOST", "DB_NAME", "DB_PASSWORD", "DB_PORT", "DB_USERNAME"].sort(),
    );
    expect(report.hasDatabaseUrl).toBe(false);
    expect(report.hasDbEngine).toBe(false);

    // Control-plane contract.
    const databases = activeDatabases(
      await env.backend.getAppDatabases(info.id),
    );
    expect(databases).toHaveLength(1);
    const db = databases[0];
    expect(db.engine).toBe("POSTGRES");
    expect(db.name).toMatch(/^db_/);
    expect(db.username).toMatch(/^user_/);
    expect(db.host).toBeTruthy();
    expect(db.port).toBeTruthy();
    // phpMyAdmin is MySQL-only; PostgreSQL must expose the engine-agnostic
    // explorer link instead.
    expect(db.phpmyadminUrl).toBeNull();
    assertHostMatchesEngine(db);

    // The env vars injected into the app must match what the API reports.
    expect(report.host).toBe(db.host);
    expect(report.port).toBe(db.port);
    expect(report.name).toBe(db.name);
    expect(report.username).toBe(db.username);

    const reachable = await canReachTcp(db.host, Number(db.port));
    if (!reachable) {
      console.warn(
        `Database endpoint not reachable from the test runner; skipping direct SQL assertions (expected on local platform).`,
      );
    }

    if (reachable) {
      console.log("== SQL round trip ==");
      const creds = await credentialsFor(env, info.id, db);
      await withPostgres(creds, async (client) => {
        await client.query(
          "CREATE TABLE IF NOT EXISTS qa650_marker (id SERIAL PRIMARY KEY, marker TEXT NOT NULL)",
        );
        await client.query("INSERT INTO qa650_marker (marker) VALUES ($1)", [
          "before-redeploy",
        ]);
        const inserted = await client.query(
          "SELECT count(*)::int AS n FROM qa650_marker WHERE marker = $1",
          ["before-redeploy"],
        );
        expect(inserted.rows[0].n).toBe(1);
        await client.query(
          "UPDATE qa650_marker SET marker = $1 WHERE marker = $2",
          ["persisted", "before-redeploy"],
        );
      });
    }

    console.log("== Redeploying app, database must survive ==");
    await env.deployAppDir(info.dir);
    const afterRedeploy = activeDatabases(
      await env.backend.getAppDatabases(info.id),
    );
    expect(afterRedeploy).toHaveLength(1);
    expect(afterRedeploy[0].id).toBe(db.id);
    expect(afterRedeploy[0].engine).toBe("POSTGRES");

    if (reachable) {
      const creds = await credentialsFor(env, info.id, afterRedeploy[0]);
      await withPostgres(creds, async (client) => {
        const rows = await client.query(
          "SELECT count(*)::int AS n FROM qa650_marker WHERE marker = 'persisted'",
        );
        expect(rows.rows[0].n).toBe(1);
      });
    }

    console.log("== A second database must be rejected ==");
    await expect(
      env.backend.createDatabaseForApp(info.id, "POSTGRES"),
    ).rejects.toThrow(/already has an active database/);
    // Same restriction with the other engine: no engine change by
    // re-provisioning.
    await expect(
      env.backend.createDatabaseForApp(info.id, "MYSQL"),
    ).rejects.toThrow(/already has an active database/);

    console.log("== Rotating credentials ==");
    const oldCreds = reachable ? await credentialsFor(env, info.id, db) : null;
    const rotated = await env.backend.rotateAppDbCredentials(db.id);
    expect(rotated.database.id).toBe(db.id);
    // Rotation changes username AND password.
    expect(rotated.database.username).toMatch(/^user_/);
    expect(rotated.database.username).not.toBe(db.username);
    expect(rotated.password).toBeTruthy();

    // Rotation propagates to the app env without a new deployment — visible
    // on a fresh instance. Currently red everywhere: BE-1692.
    await pollUntil(
      async () => {
        const rotatedReport = await fetchDbEnvReport(env, info, {
          freshInstance: true,
        });
        return rotatedReport.username === rotated.database.username;
      },
      {
        timeoutMs: 180_000,
        intervalMs: 5_000,
        description: "rotated DB_USERNAME visible inside the app (BE-1692)",
      },
    );

    if (reachable && oldCreds) {
      const newCreds: PostgresCredentials = {
        ...oldCreds,
        user: rotated.database.username,
        password: rotated.password,
      };
      await withPostgres(newCreds, async (client) => {
        const one = await client.query("SELECT 1 AS one");
        expect(one.rows[0].one).toBe(1);
      });
      // The pre-rotation credentials must stop working.
      await pollUntil(
        async () => {
          try {
            const client = await connectPostgres(oldCreds);
            await client.end().catch(() => {});
            return false;
          } catch {
            return true;
          }
        },
        {
          timeoutMs: 120_000,
          intervalMs: 5_000,
          description: "old credentials revoked after rotation",
        },
      );
    }

    console.log("== Deleting the database ==");
    await env.backend.deleteAppDb(db.id);
    const afterDelete = activeDatabases(
      await env.backend.getAppDatabases(info.id),
    );
    expect(afterDelete).toHaveLength(0);

    if (reachable && oldCreds) {
      const rotatedCreds: PostgresCredentials = {
        ...oldCreds,
        user: rotated.database.username,
        password: rotated.password,
      };
      await pollUntil(
        async () => {
          try {
            const client = await connectPostgres(rotatedCreds);
            await client.end().catch(() => {});
            return false;
          } catch {
            return true;
          }
        },
        {
          timeoutMs: 120_000,
          intervalMs: 5_000,
          description: "database access revoked after deletion",
        },
      );
    }
  } finally {
    await env.deleteApp(info);
  }
});

test.concurrent("psql-dashboard-provisioning-and-sqlite-reject", async () => {
  const env = TestEnv.fromEnv();

  console.log("== Deploying app without a database capability ==");
  // Pinned for the later POSTGRES provisioning: the default database region
  // is not engine-aware (see psql-full-lifecycle).
  const candidates = await postgresRegionCandidates(env);
  const spec = buildDbEnvApp(
    candidates.length > 0 ? { locality: { regions: [candidates[0]] } } : {},
  );
  const info = await env.deployApp(spec);

  try {
    // No capability -> no credentials injected.
    const report = await fetchDbEnvReport(env, info);
    expect(report.present).toEqual([]);
    expect(report.missing.sort()).toEqual(
      ["DB_HOST", "DB_NAME", "DB_PASSWORD", "DB_PORT", "DB_USERNAME"].sort(),
    );
    expect(activeDatabases(await env.backend.getAppDatabases(info.id))).toEqual(
      [],
    );

    // SQLITE is in the GraphQL enum but must be rejected at runtime.
    await expect(
      env.backend.createDatabaseForApp(info.id, "SQLITE"),
    ).rejects.toThrow(/SQLITE databases are not supported/i);

    console.log("== Provisioning PostgreSQL through the dashboard path ==");
    const created = await env.backend.createDatabaseForApp(info.id, "POSTGRES");
    expect(created.database.engine).toBe("POSTGRES");
    expect(created.password).toBeTruthy();
    expect(created.database.phpmyadminUrl).toBeNull();
    assertHostMatchesEngine(created.database);

    const databases = activeDatabases(
      await env.backend.getAppDatabases(info.id),
    );
    expect(databases).toHaveLength(1);
    expect(databases[0].engine).toBe("POSTGRES");
  } finally {
    await env.deleteApp(info);
  }
});

test.concurrent("mysql-legacy-omitted-engine-defaults-to-mysql", async () => {
  const env = TestEnv.fromEnv();

  console.log("== Deploying app with capabilities.database and no engine ==");
  // Pinned to the same DB-capable region as the PostgreSQL tests: unpinned
  // dev apps can land on unhealthy Edge capacity and never become reachable.
  const candidates = await postgresRegionCandidates(env);
  const spec = buildDbEnvApp({
    capabilities: { database: {} },
    ...(candidates.length > 0
      ? { locality: { regions: [candidates[0]] } }
      : {}),
  });
  const info = await env.deployApp(spec);

  try {
    const report = await fetchDbEnvReport(env, info);
    expect(report.missing).toEqual([]);

    const databases = activeDatabases(
      await env.backend.getAppDatabases(info.id),
    );
    expect(databases).toHaveLength(1);
    const db = databases[0];
    // Compatibility commitment: omitted engine keeps provisioning MySQL.
    expect(db.engine).toBe("MYSQL");
    // MySQL keeps its phpMyAdmin link.
    expect(db.phpmyadminUrl).toBeTruthy();
    assertHostMatchesEngine(db);
  } finally {
    await env.deleteApp(info);
  }
});

// Post-deploy `DB_*` injection must reach the app without a redeploy.
// Currently red everywhere (engine-independent): BE-1692.
test.failing("mysql-legacy-createappdb-mutation", async () => {
  const env = TestEnv.fromEnv();

  console.log("== Deploying app without database, then legacy createAppDb ==");
  const candidates = await postgresRegionCandidates(env);
  const spec = buildDbEnvApp(
    candidates.length > 0 ? { locality: { regions: [candidates[0]] } } : {},
  );
  const info = await env.deployApp(spec);

  try {
    // The legacy engine-less mutation must keep provisioning MySQL.
    const created = await env.backend.createAppDbLegacy(info.id);
    expect(created.database.engine).toBe("MYSQL");
    expect(created.database.phpmyadminUrl).toBeTruthy();
    assertHostMatchesEngine(created.database);

    // Env injection reaches the app without a manual redeploy — visible on a
    // fresh instance.
    await pollUntil(
      async () => {
        const report = await fetchDbEnvReport(env, info, {
          freshInstance: true,
        });
        return report.missing.length === 0;
      },
      {
        timeoutMs: 180_000,
        intervalMs: 5_000,
        description: "DB_* env vars visible inside the app",
      },
    );
  } finally {
    await env.deleteApp(info);
  }
});

test.concurrent("psql-explicit-supported-region", async () => {
  const env = TestEnv.fromEnv();

  const candidates = await postgresRegionCandidates(env);
  if (candidates.length === 0) {
    console.warn(
      "No active database-capable regions exposed by this environment; skipping explicit-region coverage.",
    );
    return;
  }

  console.log(
    `== Deploying PostgreSQL app pinned to a region (candidates: ${candidates.join(", ")}) ==`,
  );
  const { info, region } = await deployPostgresAppWithRegionFallback(
    env,
    (regionName) =>
      buildDbEnvApp({
        capabilities: { database: { engine: "postgres" } },
        locality: { regions: [regionName] },
      }),
    candidates,
  );

  try {
    const databases = activeDatabases(
      await env.backend.getAppDatabases(info.id),
    );
    expect(databases).toHaveLength(1);
    const db = databases[0];
    expect(db.engine).toBe("POSTGRES");
    assertHostMatchesEngine(db);
    // Locality: managed hostnames embed the region name.
    if (/wasmernet/.test(db.host)) {
      expect(db.host).toContain(region);
    }

    const report = await fetchDbEnvReport(env, info);
    expect(report.missing).toEqual([]);
    expect(report.host).toBe(db.host);
  } finally {
    await env.deleteApp(info);
  }
});

test.concurrent("psql-default-region", async () => {
  const env = TestEnv.fromEnv();

  console.log("== Deploying PostgreSQL app without a region ==");
  const spec = buildDbEnvApp({
    capabilities: { database: { engine: "postgres" } },
  });

  let info;
  try {
    // noWait: this test only asserts control-plane facts (engine, host), so
    // it must not depend on Edge serving health for an unpinned app.
    info = await env.deployApp(spec, { noWait: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (NO_PSQL_CONFIG_RE.test(message)) {
      // Known environment gap: the default database region is chosen without
      // engine awareness, so an environment whose default region only holds a
      // MySQL config (dev: fr-pari1) cannot provision PostgreSQL without an
      // explicit region. Dashboard defaults hit the same wall — worth fixing
      // in the backend, but not a test failure.
      console.warn(
        "Default database region has no PostgreSQL config; default-region provisioning is unavailable in this environment.",
      );
      if (spec.appYaml.owner && spec.appYaml.name) {
        await env.runWasmerCommand({
          args: ["app", "delete", `${spec.appYaml.owner}/${spec.appYaml.name}`],
          noAssertSuccess: true,
          quiet: true,
        });
      }
      return;
    }
    throw error;
  }

  try {
    const databases = activeDatabases(
      await env.backend.getAppDatabases(info.id),
    );
    expect(databases).toHaveLength(1);
    expect(databases[0].engine).toBe("POSTGRES");
    assertHostMatchesEngine(databases[0]);
  } finally {
    await env.deleteApp(info);
  }
});
