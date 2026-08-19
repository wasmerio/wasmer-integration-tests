// Apps seeder (spec §3.1 step 2–3, D-D): a small anchor set of *real*
// deploys mints IDs the backend and Edge both know, then everything
// scale-shaped — the portfolio beyond the anchors, deployment history,
// custom domains, disks — is fabricated rows in the exact tables the
// backend already joins, guarded by the D-B live-column assertion. Every
// created resource is recorded by concrete ID before control returns.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import type { Client } from "pg";
import {
  assertTableColumns,
  connectSimulatorPostgres,
} from "../clients/postgres";
import { SimulatorBackend } from "../clients/graphql";
import { appNames } from "../names";
import { parseSizeBytes } from "../schema";
import {
  FIXTURE_NAMES,
  fixturePackage,
  writeFixtureApp,
  type FixtureName,
} from "../fixtures";
import { splitCount } from "../traffic";
import type { SimulatorDeclaration, AppsBlock } from "../schema";
import type { EmitEntry, SeedContext, Seeder } from "../registry";
import type { Random } from "../random";

/** Real deploys are anchors only (D-D): they cost seconds each, and a
 * fabricated row renders identically in the dashboard. */
export const ANCHOR_LIMIT = 12;
const DEPLOY_CONCURRENCY = 4;
const DEPLOY_ATTEMPTS = 3;

/** D-B assertion set for everything this seeder fabricates. Types are
 * information_schema.columns `data_type` values, verified against the live
 * platform on 2026-08-14. */
export const FABRICATION_TABLES: Record<string, Record<string, string>> = {
  deploy_deployapp: {
    id: "integer",
    name: "character varying",
    owner_object_id: "integer",
    owner_content_type_id: "integer",
    created_at: "timestamp with time zone",
    updated_at: "timestamp with time zone",
    active_version_id: "integer",
    created_by_id: "integer",
    state: "character varying",
    external_id: "character varying",
    force_https: "boolean",
    hidden: "boolean",
    managed: "boolean",
    cdn_cache_enabled: "boolean",
  },
  deploy_deployappversion: {
    id: "integer",
    version_number: "bigint",
    created_at: "timestamp with time zone",
    updated_at: "timestamp with time zone",
    app_id: "integer",
    published_by_id: "integer",
    yaml_config: "text",
    user_yaml_config: "text",
    client_name: "character varying",
    external_id: "character varying",
    disabled_permanently: "boolean",
  },
  deploy_rollout: {
    id: "integer",
    created_at: "timestamp with time zone",
    updated_at: "timestamp with time zone",
    status: "character varying",
    deployapp_id: "integer",
    deployapp_version_id: "integer",
    rollout_type: "character varying",
    external_id: "character varying",
  },
  deploy_appalias: {
    id: "integer",
    name: "character varying",
    is_default: "boolean",
    app_id: "integer",
    hostname: "character varying",
    kind: "character varying",
    text: "character varying",
    created_at: "timestamp with time zone",
    updated_at: "timestamp with time zone",
    state: "character varying",
    external_id: "character varying",
    is_added_by_ui: "boolean",
  },
  deploy_appvolume: {
    id: "integer",
    created_at: "timestamp with time zone",
    updated_at: "timestamp with time zone",
    app_id: "integer",
    region_id: "integer",
    volume_id: "character varying",
    mount_path: "character varying",
    max_size_bytes: "bigint",
    s3_enabled: "boolean",
    is_added_by_ui: "boolean",
    external_id: "character varying",
  },
};

export interface DeployedAppEntry {
  kind: "deployed-app";
  namespace: string;
  name: string;
  appId: string;
}

export interface PostgresRowsEntry {
  kind: "postgres-rows";
  table: string;
  pks: number[];
}

interface DeployResult {
  name: string;
  appId: string;
  fixture: FixtureName;
  versionId: string | null;
  url: string | null;
}

function simExternalId(random: Random, prefix: string): string {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let suffix = "sim";
  for (let index = 0; index < 9; index++) {
    suffix += alphabet[random.int(0, alphabet.length - 1)];
  }
  return `${prefix}_${suffix}`;
}

/** Normalize `apps.fixture` (single name or weighted mix) into ordered
 * (fixture, weight) pairs — FIXTURE_NAMES order so the expansion is
 * deterministic regardless of YAML key order. */
export function normalizeFixtureMix(
  fixture: AppsBlock["fixture"],
): Array<{ fixture: FixtureName; weight: number }> {
  if (typeof fixture === "string") {
    return [{ fixture, weight: 1 }];
  }
  const entries = FIXTURE_NAMES.filter(
    (name) => fixture[name] !== undefined,
  ).map((name) => ({ fixture: name, weight: fixture[name] as number }));
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  return entries.map((entry) => ({
    fixture: entry.fixture,
    weight: entry.weight / total,
  }));
}

/** Per-app fixture assignment: exact largest-remainder counts per fixture,
 * then a seeded shuffle so the anchor set samples the mix instead of the
 * first fixture monopolizing it. Deterministic under the scenario seed. */
export function assignFixtures(
  fixture: AppsBlock["fixture"],
  count: number,
  random: Random,
): FixtureName[] {
  const mix = normalizeFixtureMix(fixture);
  const counts = splitCount(
    count,
    mix.map((entry) => entry.weight),
  );
  const assigned: FixtureName[] = [];
  mix.forEach((entry, index) => {
    for (let repeat = 0; repeat < counts[index]; repeat++) {
      assigned.push(entry.fixture);
    }
  });
  const stream = random.fork("fixture-assignment");
  for (let i = assigned.length - 1; i > 0; i--) {
    const j = stream.int(0, i);
    [assigned[i], assigned[j]] = [assigned[j], assigned[i]];
  }
  return assigned;
}

function runWasmerDeploy(
  dir: string,
  env: Record<string, string>,
  onLine?: (line: string) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "wasmer",
      ["deploy", "--non-interactive", "--format", "json", "--no-wait"],
      {
        cwd: dir,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (onLine) {
        for (const line of text.split("\n")) {
          if (line.trim() !== "") {
            onLine(line);
          }
        }
      }
    });
    child.on("error", (err) =>
      reject(
        new Error(
          `failed to spawn wasmer (is the CLI installed?): ${err.message}`,
        ),
      ),
    );
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function deployAnchor(
  name: string,
  fixture: FixtureName,
  ctx: SeedContext,
): Promise<DeployResult> {
  const namespace = ctx.ids.namespace;
  const token = ctx.ids.token;
  if (namespace === undefined || token === undefined) {
    throw new Error("apps seeder ran before the account seeder (§3.1 order)");
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "sim-app-"));
  try {
    writeFixtureApp(fixture, dir, name, namespace);
    let result: { code: number; stdout: string; stderr: string };
    let jsonStart: number;
    // The CLI intermittently exits 0 with an empty stdout under
    // concurrent deploys; both failure shapes are retried.
    for (let attempt = 1; ; attempt++) {
      result = await runWasmerDeploy(
        dir,
        {
          WASMER_REGISTRY: ctx.env["WASMER_REGISTRY"],
          WASMER_TOKEN: token,
          WASMER_NAMESPACE: namespace,
        },
        ctx.verbose ? (line) => ctx.io.err(`  [${name}] ${line}`) : undefined,
      );
      jsonStart = result.stdout.indexOf("{");
      if (result.code === 0 && jsonStart !== -1) {
        break;
      }
      const failure =
        result.code !== 0
          ? `wasmer deploy failed for "${name}" (exit ${result.code}): ` +
            result.stderr.slice(-500)
          : `wasmer deploy for "${name}" produced no JSON output: ` +
            result.stderr.slice(-300);
      if (attempt >= DEPLOY_ATTEMPTS) {
        throw new Error(failure);
      }
      ctx.io.err(
        `apps: deploy of ${name} failed (attempt ${attempt}/${DEPLOY_ATTEMPTS}), retrying`,
      );
    }
    const parsed = JSON.parse(result.stdout.slice(jsonStart)) as {
      id?: string;
      url?: string;
      app?: { id?: string };
    };
    const appId = parsed.app?.id;
    if (appId === undefined) {
      throw new Error(
        `wasmer deploy for "${name}" returned no app id in its JSON output`,
      );
    }
    return {
      name,
      appId,
      fixture,
      versionId: parsed.id ?? null,
      url: parsed.url ?? null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read back every ID later writers correlate on (spec §3.1 step 3): the
 * numeric app/version/owner PKs live only in the backend database. */
async function readBackIds(
  postgres: Client,
  namespacePk: number,
  deployed: DeployResult[],
  ctx: SeedContext,
): Promise<void> {
  for (const app of deployed) {
    const row = await postgres.query<{
      id: number;
      active_version_id: number | null;
      version_external_id: string | null;
    }>(
      `SELECT a.id, a.active_version_id, v.external_id AS version_external_id
       FROM deploy_deployapp a
       LEFT JOIN deploy_deployappversion v ON v.id = a.active_version_id
       WHERE a.external_id = $1`,
      [app.appId],
    );
    if (row.rows.length !== 1 || row.rows[0].active_version_id === null) {
      throw new Error(
        `ID read-back failed for app "${app.name}" (${app.appId}): ` +
          "no deploy_deployapp row or no active version — refusing to " +
          "proceed to telemetry with partial correlation",
      );
    }
    ctx.ids.apps.push({
      name: app.name,
      appId: app.appId,
      appPk: row.rows[0].id,
      versionId: app.versionId,
      versionPk: row.rows[0].active_version_id,
      url: app.url,
      real: true,
      fixture: app.fixture,
    });
  }
  if (ctx.verbose) {
    ctx.io.err(
      `apps: ID map ${ctx.ids.apps
        .map((app) => `${app.name}=>pk ${app.appPk} owner ${namespacePk}`)
        .join(", ")}`,
    );
  }
}

interface FabricationCounts {
  apps: number;
  versionsPerApp: number;
  failedPerApp: number;
  customDomains: number;
  disks: number;
}

function fabricationPlan(apps: AppsBlock): FabricationCounts {
  return {
    apps: Math.max(0, apps.count - Math.min(apps.count, ANCHOR_LIMIT)),
    versionsPerApp: Math.max(0, (apps.deployments?.perApp ?? 1) - 1),
    failedPerApp: apps.deployments?.failed ?? 0,
    customDomains: apps.domains?.custom ?? 0,
    disks: apps.disks?.attached ?? 0,
  };
}

/** All fabricated rows for the portfolio, inserted in one transaction and
 * recorded per table after commit. Timestamps spread into the past off `now`
 * through the seeded stream so history looks organic yet reproducible. */
async function fabricate(
  postgres: Client,
  declaration: SimulatorDeclaration,
  ctx: SeedContext,
  emit: EmitEntry,
): Promise<void> {
  const apps = declaration.apps;
  if (apps === undefined) {
    return;
  }
  const counts = fabricationPlan(apps);
  const random = ctx.random.fork("fabrication");
  const namespacePk = ctx.ids.namespacePk;
  const userPk = ctx.ids.userPk;
  const namespace = ctx.ids.namespace;
  if (
    namespacePk === undefined ||
    userPk === undefined ||
    namespace === undefined
  ) {
    throw new Error("apps seeder ran before the account seeder (§3.1 order)");
  }

  for (const [table, columns] of Object.entries(FABRICATION_TABLES)) {
    await assertTableColumns(postgres, table, columns);
  }
  const contentType = await postgres.query<{ id: number }>(
    `SELECT id FROM django_content_type
     WHERE app_label = 'registry' AND model = 'namespace'`,
  );
  if (contentType.rows.length !== 1) {
    throw new Error(
      "cannot resolve the registry.namespace content type id — the " +
        "backend's content-type table has moved",
    );
  }
  const namespaceContentType = contentType.rows[0].id;

  const created: Record<string, number[]> = {
    deploy_deployapp: [],
    deploy_deployappversion: [],
    deploy_rollout: [],
    deploy_appalias: [],
    deploy_appvolume: [],
  };
  const nowMs = Date.now();
  const dayMs = 86_400_000;
  const at = (daysAgo: number): string =>
    new Date(nowMs - daysAgo * dayMs).toISOString();

  const versionYaml = (name: string, fixture: FixtureName): string =>
    `kind: wasmer.io/App.v0\nname: ${name}\nowner: ${namespace}\n` +
    `package: ${fixturePackage(fixture)}\n`;

  const assignments = assignFixtures(apps.fixture, apps.count, ctx.random);

  await postgres.query("BEGIN");
  try {
    // Portfolio beyond the anchors (D-D): app + one active version + alias.
    const anchorsTotal = apps.count - counts.apps;
    const fabricatedNames = appNames(
      ctx.random.fork("fabricated-names"),
      apps.count,
    ).slice(anchorsTotal);
    for (const [fabricatedIndex, name] of fabricatedNames.entries()) {
      const fixture = assignments[anchorsTotal + fabricatedIndex];
      const ageDays = random.int(30, 400) + random.next();
      const appExternal = simExternalId(random, "da");
      const appRow = await postgres.query<{ id: number }>(
        `INSERT INTO deploy_deployapp
           (name, owner_object_id, owner_content_type_id, created_at,
            updated_at, created_by_id, state, external_id, force_https,
            hidden, managed, cdn_cache_enabled)
         VALUES ($1, $2, $3, $4, $4, $5, 'active:visible', $6, true, false,
                 false, false)
         RETURNING id`,
        [
          name,
          namespacePk,
          namespaceContentType,
          at(ageDays),
          userPk,
          appExternal,
        ],
      );
      const appPk = appRow.rows[0].id;
      created["deploy_deployapp"].push(appPk);

      const versionRow = await postgres.query<{ id: number }>(
        `INSERT INTO deploy_deployappversion
           (version_number, created_at, updated_at, app_id, published_by_id,
            yaml_config, user_yaml_config, client_name, external_id,
            disabled_permanently)
         VALUES (1, $1, $1, $2, $3, $4, $4, 'simulator', $5, false)
         RETURNING id`,
        [
          at(ageDays),
          appPk,
          userPk,
          versionYaml(name, fixture),
          simExternalId(random, "dav"),
        ],
      );
      const versionPk = versionRow.rows[0].id;
      created["deploy_deployappversion"].push(versionPk);
      await postgres.query(
        "UPDATE deploy_deployapp SET active_version_id = $1 WHERE id = $2",
        [versionPk, appPk],
      );

      const aliasRow = await postgres.query<{ id: number }>(
        `INSERT INTO deploy_appalias
           (name, is_default, app_id, hostname, kind, text, created_at,
            updated_at, state, external_id, is_added_by_ui)
         VALUES ($1, true, $2, $3, 'deployment', $4, $5, $5, 'verified', $6,
                 false)
         RETURNING id`,
        [
          name,
          appPk,
          ctx.env["WASMER_APP_DOMAIN"] ?? "localhost",
          `${name}.${ctx.env["WASMER_APP_DOMAIN"] ?? "localhost"}`,
          at(ageDays),
          simExternalId(random, "daa"),
        ],
      );
      created["deploy_appalias"].push(aliasRow.rows[0].id);

      ctx.ids.apps.push({
        name,
        appId: appExternal,
        appPk,
        versionId: null,
        versionPk,
        url: `https://${name}.${ctx.env["WASMER_APP_DOMAIN"] ?? "localhost"}`,
        real: false,
        fixture,
      });
    }

    // Deployment history for every app: extra versions plus a rollout row
    // per deployment (the dashboard's Deployments tab reads rollouts), with
    // the declared number of failures.
    for (const app of ctx.ids.apps) {
      const versions = counts.versionsPerApp;
      // Anchors can hold >1 version when a flaked deploy was retried.
      const maxVersionRow = await postgres.query<{ max: string | null }>(
        `SELECT MAX(version_number) AS max FROM deploy_deployappversion
         WHERE app_id = $1`,
        [app.appPk],
      );
      const baseVersion = Number(maxVersionRow.rows[0].max ?? 1);
      for (let index = 0; index < versions; index++) {
        const ageDays = random.next() * 28;
        const failed = index >= versions - counts.failedPerApp; // most recent N fail
        let versionPk: number | null = null;
        if (!failed) {
          const versionRow = await postgres.query<{ id: number }>(
            `INSERT INTO deploy_deployappversion
               (version_number, created_at, updated_at, app_id,
                published_by_id, yaml_config, user_yaml_config, client_name,
                external_id, disabled_permanently)
             VALUES ($1, $2, $2, $3, $4, $5, $5, 'simulator', $6, false)
             RETURNING id`,
            [
              baseVersion + index + 1,
              at(ageDays),
              app.appPk,
              userPk,
              versionYaml(app.name, app.fixture as FixtureName),
              simExternalId(random, "dav"),
            ],
          );
          versionPk = versionRow.rows[0].id;
          created["deploy_deployappversion"].push(versionPk);
        }
        const rolloutRow = await postgres.query<{ id: number }>(
          `INSERT INTO deploy_rollout
             (created_at, updated_at, status, deployapp_id,
              deployapp_version_id, rollout_type, external_id)
           VALUES ($1, $1, $2, $3, $4, 'package', $5)
           RETURNING id`,
          [
            at(ageDays),
            failed ? "failed" : "success",
            app.appPk,
            versionPk,
            simExternalId(random, "dr"),
          ],
        );
        created["deploy_rollout"].push(rolloutRow.rows[0].id);
      }
    }

    // Custom domains, spread over the first apps.
    for (let index = 0; index < counts.customDomains; index++) {
      const app = ctx.ids.apps[index % ctx.ids.apps.length];
      const domain = `${app.name}.example-${index + 1}.test`;
      const aliasRow = await postgres.query<{ id: number }>(
        `INSERT INTO deploy_appalias
           (name, is_default, app_id, hostname, kind, text, created_at,
            updated_at, state, external_id, is_added_by_ui)
         VALUES ($1, false, $2, $3, 'custom', $3, $4, $4, 'verified', $5,
                 true)
         RETURNING id`,
        [
          domain,
          app.appPk,
          domain,
          at(random.next() * 60),
          simExternalId(random, "daa"),
        ],
      );
      created["deploy_appalias"].push(aliasRow.rows[0].id);
    }

    // Attached disks. region_id must reference a real region; the platform
    // seeds at least one.
    if (counts.disks > 0) {
      const region = await postgres.query<{ id: number }>(
        "SELECT id FROM deploy_appregion ORDER BY id LIMIT 1",
      );
      if (region.rows.length === 0) {
        throw new Error(
          "disks declared but the backend has no deploy_appregion row to " +
            "attach volumes to",
        );
      }
      const sizes = declaration.apps?.disks?.sizes ?? ["1G"];
      for (let index = 0; index < counts.disks; index++) {
        const app = ctx.ids.apps[index % ctx.ids.apps.length];
        const size = sizes[index % sizes.length];
        const volumeRow = await postgres.query<{ id: number }>(
          `INSERT INTO deploy_appvolume
             (created_at, updated_at, app_id, region_id, volume_id,
              mount_path, max_size_bytes, s3_enabled, is_added_by_ui,
              external_id)
           VALUES ($1, $1, $2, $3, $4, '/data', $5, false, true, $6)
           RETURNING id`,
          [
            at(random.next() * 60),
            app.appPk,
            region.rows[0].id,
            `sim-vol-${index + 1}`,
            parseSizeBytes(size),
            simExternalId(random, "dvol"),
          ],
        );
        created["deploy_appvolume"].push(volumeRow.rows[0].id);
      }
    }

    await postgres.query("COMMIT");
  } catch (err) {
    await postgres.query("ROLLBACK").catch(() => undefined);
    throw err;
  }

  // Recorded only after commit: a rolled-back transaction leaves nothing,
  // so nothing must be recorded for it.
  for (const [table, pks] of Object.entries(created)) {
    if (pks.length > 0) {
      emit({ kind: "postgres-rows", table, pks } satisfies PostgresRowsEntry);
    }
  }
  const total = Object.values(created).reduce(
    (sum, pks) => sum + pks.length,
    0,
  );
  if (total > 0) {
    ctx.io.err(`apps: fabricated ${total} backend rows (D-D)`);
  }
}

export const appsSeeder: Seeder = {
  block: "apps",

  plan(declaration: SimulatorDeclaration, planCtx): string[] {
    const apps = declaration.apps;
    if (apps === undefined) {
      return [];
    }
    const counts = fabricationPlan(apps);
    const anchors = Math.min(apps.count, ANCHOR_LIMIT);
    const names = appNames(planCtx.random.fork("fabricated-names"), apps.count);
    const assignments = assignFixtures(
      apps.fixture,
      apps.count,
      planCtx.random,
    );
    const perFixture = FIXTURE_NAMES.map((name) => ({
      name,
      count: assignments.filter((assigned) => assigned === name).length,
    })).filter((entry) => entry.count > 0);
    const lines = [
      `apps: ${apps.count} total — ${anchors} real anchor deploys` +
        (counts.apps > 0 ? `, ${counts.apps} fabricated` : ""),
      `  fixtures: ${perFixture.map((entry) => `${entry.name} ×${entry.count}`).join(", ")}`,
      `  names: ${names.slice(0, 5).join(", ")}${apps.count > 5 ? ", …" : ""}`,
    ];
    if (apps.deployments !== undefined) {
      lines.push(
        `  deployment history: ${apps.deployments.perApp} per app ` +
          `(${apps.deployments.failed} failed)`,
      );
    }
    if (apps.domains !== undefined) {
      lines.push(`  custom domains: ${apps.domains.custom}`);
    }
    if (apps.disks !== undefined) {
      lines.push(
        `  disks: ${apps.disks.attached} (sizes ${apps.disks.sizes.join(", ")})`,
      );
    }
    return lines;
  },

  async apply(
    declaration: SimulatorDeclaration,
    ctx: SeedContext,
    emit: EmitEntry,
  ): Promise<void> {
    const apps = declaration.apps;
    if (apps === undefined) {
      return;
    }
    const namespace = ctx.ids.namespace;
    if (namespace === undefined) {
      throw new Error("apps seeder ran before the account seeder (§3.1 order)");
    }
    const anchors = Math.min(apps.count, ANCHOR_LIMIT);
    const names = appNames(ctx.random.fork("fabricated-names"), apps.count);
    const anchorNames = names.slice(0, anchors);
    const assignments = assignFixtures(apps.fixture, apps.count, ctx.random);

    const started = Date.now();
    ctx.io.err(
      `apps: deploying ${anchors} anchor app${anchors === 1 ? "" : "s"} as ` +
        `"${namespace}"…`,
    );
    const deployed: DeployResult[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= anchorNames.length) {
          return;
        }
        const name = anchorNames[index];
        const result = await deployAnchor(name, assignments[index], ctx);
        // Flushed before the next deploy starts: a crash leaves every
        // already-created app in the descriptor.
        emit({
          kind: "deployed-app",
          namespace,
          name,
          appId: result.appId,
        } satisfies DeployedAppEntry);
        // Slot by name index, not completion order: later writers key
        // per-app weights on this order, which must match the plan's.
        deployed[index] = result;
        ctx.io.err(`apps: deployed ${name} (${result.appId})`);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(DEPLOY_CONCURRENCY, anchorNames.length) },
        () => worker(),
      ),
    );
    ctx.io.err(
      `apps: ${deployed.length} anchors deployed in ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s`,
    );

    const postgres = await connectSimulatorPostgres(ctx.env);
    try {
      const namespacePk = ctx.ids.namespacePk;
      if (namespacePk === undefined) {
        throw new Error(
          "apps seeder ran before the account seeder (§3.1 order)",
        );
      }
      await readBackIds(postgres, namespacePk, deployed, ctx);
      await fabricate(postgres, declaration, ctx, emit);
    } finally {
      await postgres.end().catch(() => undefined);
    }
  },
};

/** Sanity used by tests: the anchor set for a declared count. */
export function anchorCount(count: number): number {
  return Math.min(count, ANCHOR_LIMIT);
}

export { SimulatorBackend };
