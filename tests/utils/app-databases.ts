import { TestEnv } from "../../src/env";
import { AppDefinition } from "../../src/index";
import { AppInfo } from "../../src/backend";

// The backend's default database region (`default_db_region`) is not
// engine-aware: it picks the first Databases-capable region, which may only
// hold a MySQL config. On dev only `fr-roub1` has a PostgreSQL config, so
// provisioning that must succeed pins to a candidate region instead of
// relying on the default.
export const NO_PSQL_CONFIG_RE = /No postgres database config available/i;

// Active database-capable region names, ordered by preference for PostgreSQL:
// the WASMER_PSQL_REGION override first, then fr-roub1 (the region known to
// carry PostgreSQL configs on dev and prod), then the rest.
export async function postgresRegionCandidates(
  env: TestEnv,
): Promise<string[]> {
  const regions = await env.backend.getAllAppRegions({
    active: true,
    supportsDatabases: true,
  });
  const names = regions.map((region) => region.name);

  const ordered: string[] = [];
  const push = (name?: string | null) => {
    if (name && names.includes(name) && !ordered.includes(name)) {
      ordered.push(name);
    }
  };
  push(process.env.WASMER_PSQL_REGION);
  push("fr-roub1");
  for (const name of names) {
    push(name);
  }
  return ordered;
}

// Deploy a PostgreSQL app, falling back through candidate regions when one
// lacks a PostgreSQL config. Any other deploy failure is rethrown.
export async function deployPostgresAppWithRegionFallback(
  env: TestEnv,
  build: (region: string) => AppDefinition,
  candidates: string[],
): Promise<{ info: AppInfo; region: string }> {
  if (candidates.length === 0) {
    throw new Error("No active database-capable regions available");
  }

  const failures: string[] = [];
  for (const region of candidates) {
    const spec = build(region);
    try {
      const info = await env.deployApp(spec);
      return { info, region };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!NO_PSQL_CONFIG_RE.test(message)) {
        throw error;
      }
      failures.push(region);
      console.warn(
        `Region ${region} has no PostgreSQL config; trying the next candidate.`,
      );
      // A rejected database capability can still leave an app record without
      // an active version behind; best-effort cleanup.
      if (spec.appYaml.owner && spec.appYaml.name) {
        await env.runWasmerCommand({
          args: ["app", "delete", `${spec.appYaml.owner}/${spec.appYaml.name}`],
          noAssertSuccess: true,
          quiet: true,
        });
      }
    }
  }
  throw new Error(
    `No candidate region has a PostgreSQL database config (tried: ${failures.join(", ")})`,
  );
}
