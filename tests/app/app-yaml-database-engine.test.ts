import * as fs from "node:fs";
import path from "node:path";

import { TestEnv } from "../../src/env";
import {
  AppDefinition,
  buildPhpApp,
  buildTempDir,
  loadAppYaml,
  saveAppYaml,
  writeAppDefinition,
} from "../../src/index";
import { projectRoot } from "../utils/path";
import {
  deployPostgresAppWithRegionFallback,
  postgresRegionCandidates,
} from "../utils/app-databases";

// app.yaml `capabilities.database.engine` contract (BE-1659):
//
// - values are matched case-insensitively as substrings of `mysql`/`postgres`
//   (`postgresql` works, `psql` does NOT);
// - an omitted engine provisions MySQL (covered in tests/general/psql.test.ts);
// - unknown engines fail the deploy with an actionable error;
// - the engine of an existing database cannot be changed in place — the
//   database must be deleted first.

const DB_ENV_FIXTURE = path.join(
  projectRoot,
  "fixtures",
  "php",
  "db-env-report.php",
);

function buildDatabaseApp(engine?: string, region?: string): AppDefinition {
  const code = fs.readFileSync(DB_ENV_FIXTURE, "utf-8");
  return buildPhpApp(code, {
    scaling: { mode: "single_concurrency" },
    capabilities: {
      database: engine === undefined ? {} : { engine },
    },
    ...(region ? { locality: { regions: [region] } } : {}),
  });
}

// Deploy a spec that is expected to be rejected by the backend. Returns the
// combined CLI output for message assertions. Best-effort deletes the app
// afterwards: a rejected database capability can still leave an app record
// without an active version behind.
async function deployExpectingFailure(
  env: TestEnv,
  spec: AppDefinition,
): Promise<string> {
  if (!spec.appYaml.owner) {
    spec.appYaml.owner = env.namespace;
  }
  const dir = await buildTempDir(spec.files ?? {});
  await writeAppDefinition(dir, spec);
  const result = await env.runWasmerCommand({
    args: ["deploy", "--non-interactive", "--format", "json"],
    cwd: dir,
    noAssertSuccess: true,
  });
  expect(result.code).not.toBe(0);

  await env.runWasmerCommand({
    args: ["app", "delete", `${spec.appYaml.owner}/${spec.appYaml.name}`],
    noAssertSuccess: true,
    quiet: true,
  });

  return result.stderr + "\n" + result.stdout;
}

test.concurrent("app-yaml-rejects-unknown-database-engines", async () => {
  const env = TestEnv.fromEnv();

  // `psql` is the important negative case: the engine value is a substring
  // match against `mysql`/`postgres`, so the common abbreviation must fail
  // loudly instead of provisioning anything.
  for (const engine of ["psql", "sqlite"]) {
    console.log(`== Deploying with invalid engine '${engine}' ==`);
    const output = await deployExpectingFailure(env, buildDatabaseApp(engine));
    expect(output).toMatch(/Unsupported database engine/i);
    expect(output).toMatch(/mysql, postgres/i);
  }
});

test.concurrent(
  "app-yaml-engine-aliases-and-engine-change-rejection",
  async () => {
    const env = TestEnv.fromEnv();

    // `postgresql` must resolve to the postgres engine via substring match.
    // Pinned to a PostgreSQL-capable region: the default database region is
    // not engine-aware (dev's default only holds a MySQL config).
    console.log("== Deploying with engine 'postgresql' ==");
    const { info, region } = await deployPostgresAppWithRegionFallback(
      env,
      (regionName) => buildDatabaseApp("postgresql", regionName),
      await postgresRegionCandidates(env),
    );

    try {
      const databases = (await env.backend.getAppDatabases(info.id)).filter(
        (db) => !db.deletedAt,
      );
      expect(databases).toHaveLength(1);
      expect(databases[0].engine).toBe("POSTGRES");

      // Redeploying the same app with a MySQL engine must be rejected: engine
      // changes require deleting the database first. `MySQL` also exercises
      // case-insensitive parsing on the rejecting side.
      console.log("== Redeploying with engine 'MySQL' (must fail) ==");
      const appYaml = loadAppYaml(info.dir);
      appYaml.capabilities!.database!.engine = "MySQL";
      saveAppYaml(info.dir, appYaml);

      const result = await env.runWasmerCommand({
        args: ["deploy", "--non-interactive", "--format", "json"],
        cwd: info.dir,
        noAssertSuccess: true,
      });
      expect(result.code).not.toBe(0);
      const output = result.stderr + "\n" + result.stdout;
      expect(output).toMatch(/already has a postgres database/i);
      expect(output).toMatch(/delete the database/i);

      // The failed engine change must not have touched the existing database.
      const unchanged = (await env.backend.getAppDatabases(info.id)).filter(
        (db) => !db.deletedAt,
      );
      expect(unchanged).toHaveLength(1);
      expect(unchanged[0].id).toBe(databases[0].id);
      expect(unchanged[0].engine).toBe("POSTGRES");

      // The documented remedy works: delete the database, then the same
      // deploy provisions the new engine.
      console.log("== Deleting database, redeploying as MySQL ==");
      await env.backend.deleteAppDb(databases[0].id);
      const retry = await env.runWasmerCommand({
        args: ["deploy", "--non-interactive", "--format", "json"],
        cwd: info.dir,
        noAssertSuccess: true,
      });
      if (
        retry.code !== 0 &&
        /No mysql database config available/i.test(retry.stderr + retry.stdout)
      ) {
        // The pinned PostgreSQL-capable region has no MySQL config in this
        // environment; the engine-switch remedy cannot be verified here.
        console.warn(
          `Region ${region} has no MySQL config; skipping the delete-then-recreate-as-MySQL check.`,
        );
      } else {
        expect(retry.code).toBe(0);
        const replaced = (await env.backend.getAppDatabases(info.id)).filter(
          (db) => !db.deletedAt,
        );
        expect(replaced).toHaveLength(1);
        expect(replaced[0].engine).toBe("MYSQL");
        expect(replaced[0].id).not.toBe(databases[0].id);
      }
    } finally {
      await env.deleteApp(info);
    }
  },
);

test.concurrent("app-yaml-database-region-failure-ux", async () => {
  const env = TestEnv.fromEnv();
  const allRegions = await env.backend.getAllAppRegions({ active: true });

  // Multiple regions + a database is ambiguous and must be rejected.
  if (allRegions.length >= 2) {
    console.log("== Deploying database app with two regions (must fail) ==");
    const spec = buildDatabaseApp("postgres");
    spec.appYaml.locality = {
      regions: [allRegions[0].name, allRegions[1].name],
    };
    const output = await deployExpectingFailure(env, spec);
    expect(output).toMatch(/single region/i);
  } else {
    console.warn(
      "Fewer than two active regions; skipping multi-region rejection case.",
    );
  }

  // A region without database support must produce an actionable error, not a
  // phantom database.
  const nonDbRegion = allRegions.find((region) => !region.supportsDbs);
  if (nonDbRegion) {
    console.log(
      `== Deploying database app pinned to non-DB region ${nonDbRegion.name} (must fail) ==`,
    );
    const spec = buildDatabaseApp("postgres");
    spec.appYaml.locality = { regions: [nonDbRegion.name] };
    const output = await deployExpectingFailure(env, spec);
    expect(output).toMatch(
      /does not support databases|No (mysql|postgres) database config|not found/i,
    );
  } else {
    console.warn(
      "No active region without database support; skipping unsupported-region case.",
    );
  }
});
