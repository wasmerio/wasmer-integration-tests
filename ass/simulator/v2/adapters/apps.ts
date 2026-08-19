// App and app-version adapters. Section 13's rule, enforced per resource:
// an app declared `deployed` is created through the API (a direct write for
// it would be a defect), and a `fabricated` app is a direct write by
// definition. Both carry the ownership marker in `annotations`, which is
// what makes OBSERVE marker-scoped and teardown exact.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { PoolClient } from "pg";
import { defaultDiff, type ResourceAdapter, type Scope } from "../adapter";
import {
  id,
  resource,
  type OpResult,
  type Operation,
  type Resource,
} from "../model";
import type { AppSpec, AppVersionSpec } from "../specs";
import { mapConcurrent, type EngineContext } from "../engine/context";
import { writeFixtureApp, type FixtureName } from "../../fixtures";
import {
  appDomain,
  ensureUserClient,
  failed,
  inTransaction,
  namespaceContentType,
  ok,
  readMarker,
  simExternalId,
  simMarker,
} from "./common";

const DEPLOY_ATTEMPTS = 3;

interface AppRow {
  id: number;
  name: string;
  external_id: string;
  annotations: unknown;
  active_version_id: number | null;
}

export const appAdapter: ResourceAdapter<AppSpec> = {
  kind: "app",
  lane: "sdk",
  granularity: "resource",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<AppSpec>[]> {
    const namespaceId = id("namespace", scope.namespace);
    if (!ctx.identity.has(namespaceId)) {
      return [];
    }
    const namespacePk = ctx.identity.requireNumber(namespaceId, "pk");
    // Marker-scoped by construction: the predicate is in the statement, so
    // an unmanaged app can never enter the observed set (invariant I4).
    const rows = await ctx.withPostgres((client) =>
      client.query<AppRow>(
        `SELECT id, name, external_id, annotations, active_version_id
           FROM deploy_deployapp
          WHERE owner_object_id = $1
            AND deleted_at IS NULL
            AND annotations -> 'sim' ->> 'managed' = 'true'
            AND annotations -> 'sim' ->> 'scenario' = $2
          ORDER BY name`,
        [namespacePk, scope.scenario],
      ),
    );
    return rows.rows.map((row) => {
      const marker = readMarker(row.annotations);
      const resourceId = id("app", scope.namespace, row.name);
      ctx.identity.bind(resourceId, {
        pk: row.id,
        externalId: row.external_id,
        ownerPk: namespacePk,
        ...(row.active_version_id !== null
          ? { activeVersionPk: row.active_version_id }
          : {}),
      });
      return {
        id: resourceId,
        kind: "app" as const,
        spec: {
          namespace: scope.namespace,
          name: row.name,
          fixture: "",
          ageDays: 0,
        },
        // The marker carries the fingerprint the app was created with, so a
        // spec change is visible without re-deriving it from columns.
        fingerprint: marker?.fingerprint ?? "",
        deps: [],
        policy: {
          prune: "delete",
          realism: marker?.realism === "deployed" ? "deployed" : "fabricated",
        },
      };
    });
  },

  diff(desired, observed) {
    return defaultDiff("sdk", desired, observed);
  },

  async apply(
    ops: Operation<AppSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    const results: OpResult[] = [];
    const deletes = ops.filter((operation) => operation.type === "delete");
    const creates = ops.filter((operation) => operation.type === "create");
    const updates = ops.filter((operation) => operation.type === "update");

    if (deletes.length > 0) {
      results.push(...(await deleteApps(deletes, ctx)));
    }

    const deployed = creates.filter(
      (operation) => operation.desired?.policy.realism === "deployed",
    );
    const fabricated = creates.filter(
      (operation) => operation.desired?.policy.realism !== "deployed",
    );

    // The two creation paths are independent: real deploys saturate the SDK
    // lane while the fabricated batch runs as one Postgres transaction.
    const [deployedResults, fabricatedResults] = await Promise.all([
      deployApps(deployed, ctx),
      fabricateApps(fabricated, ctx),
    ]);
    results.push(...deployedResults, ...fabricatedResults);

    for (const operation of updates) {
      // Identity is the natural key, so an update is a marker refresh: the
      // spec changed in a way that does not move the app.
      try {
        const pk = ctx.identity.requireNumber(operation.id, "pk");
        await ctx.withPostgres((client) =>
          client.query(
            `UPDATE deploy_deployapp SET annotations = $1, updated_at = NOW() WHERE id = $2`,
            [
              JSON.stringify(
                simMarker(
                  ctx.scenario,
                  operation.desired?.fingerprint ?? "",
                  operation.desired?.policy.realism,
                ),
              ),
              pk,
            ],
          ),
        );
        results.push(ok(operation.id));
      } catch (err) {
        results.push(failed(operation.id, err));
      }
    }
    return results;
  },
};

async function deleteApps(
  ops: Operation<AppSpec>[],
  ctx: EngineContext,
): Promise<OpResult[]> {
  const deployed = ops.filter(
    (operation) => operation.observed?.policy.realism === "deployed",
  );
  const fabricated = ops.filter(
    (operation) => operation.observed?.policy.realism !== "deployed",
  );
  const results: OpResult[] = [];

  const viaApi = await mapConcurrent(
    deployed,
    ctx.workers.sdk,
    async (operation) => {
      try {
        const externalId = ctx.identity.requireString(
          operation.id,
          "externalId",
        );
        await ctx.lanes.sdk.run(() => ctx.admin.deleteApp(externalId));
        return ok(operation.id, { appsDeleted: 1 });
      } catch (err) {
        return failed(operation.id, err);
      }
    },
  );
  results.push(...viaApi);

  if (fabricated.length > 0) {
    const pks = fabricated.map((operation) =>
      ctx.identity.requireNumber(operation.id, "pk"),
    );
    try {
      await inTransaction(ctx, async (client) => {
        await deleteAppRows(client, pks);
      });
      results.push(
        ...fabricated.map((operation) => ok(operation.id, { appsDeleted: 1 })),
      );
    } catch (err) {
      results.push(...fabricated.map((operation) => failed(operation.id, err)));
    }
  }
  return results;
}

/** One statement per child table, keyed on the recorded app PKs - never a
 * predicate that could reach outside the recorded set. */
export async function deleteAppRows(
  client: PoolClient,
  pks: number[],
): Promise<void> {
  if (pks.length === 0) {
    return;
  }
  await client.query(
    `UPDATE deploy_deployapp SET active_version_id = NULL WHERE id = ANY($1::bigint[])`,
    [pks],
  );

  // Children first, in FK order. The lists come from the live schema's
  // foreign keys onto rollout / version / app; a table with no rows costs
  // nothing, and enumerating them beats discovering one at teardown time.
  const rolloutChildren = [
    "deploy_packagerollout",
    "deploy_githubrollout",
    "deploy_ziprollout",
    "deploy_build_times",
    "github_pr_preview_deployment",
  ];
  for (const table of rolloutChildren) {
    await client.query(
      `DELETE FROM ${table} WHERE rollout_id IN
         (SELECT id FROM deploy_rollout WHERE deployapp_id = ANY($1::bigint[]))`,
      [pks],
    );
  }
  await client.query(
    `DELETE FROM deploy_rollout WHERE deployapp_id = ANY($1::bigint[])`,
    [pks],
  );

  const versionChildren = ["deploy_appscreenshot", "deploy_nakeddeployment"];
  for (const table of versionChildren) {
    await client.query(
      `DELETE FROM ${table} WHERE app_version_id IN
         (SELECT id FROM deploy_deployappversion WHERE app_id = ANY($1::bigint[]))`,
      [pks],
    );
  }

  await client.query(
    `DELETE FROM deploy_appdatabaseusagelog WHERE db_id IN
       (SELECT id FROM deploy_appdatabase WHERE app_id = ANY($1::bigint[]))`,
    [pks],
  );
  await client.query(
    `DELETE FROM deploy_cronjob WHERE owner_object_id = ANY($1::bigint[])
       AND owner_content_type_id = (SELECT id FROM django_content_type
         WHERE app_label = 'deploy' AND model = 'deployapp')`,
    [pks],
  );
  const appChildren = [
    "deploy_appdatabase",
    "deploy_appvolume",
    "deploy_appalias",
    "deploy_appenvironment",
    "deploy_applimit",
    "deploy_appmail",
    "deploy_appsshserver",
    "deploy_apptransferrequest",
    "deploy_vault",
    "usage_metrics_clickhouseusagemetrics",
    "app_region_drains_apps",
  ];
  for (const table of appChildren) {
    await client.query(
      `DELETE FROM ${table} WHERE app_id = ANY($1::bigint[])`,
      [pks],
    );
  }
  await client.query(
    `DELETE FROM deploy_deployappversion WHERE app_id = ANY($1::bigint[])`,
    [pks],
  );
  await client.query(
    `DELETE FROM deploy_deployapp WHERE id = ANY($1::bigint[])`,
    [pks],
  );
}

async function deployApps(
  ops: Operation<AppSpec>[],
  ctx: EngineContext,
): Promise<OpResult[]> {
  if (ops.length === 0) {
    return [];
  }
  const { token } = await ensureUserClient(ctx);
  return mapConcurrent(ops, ctx.workers.sdk, async (operation) => {
    const spec = operation.desired?.spec;
    if (spec === undefined) {
      return failed(operation.id, new Error("deploy without a desired spec"));
    }
    try {
      const result = await ctx.lanes.sdk.run(() =>
        deployOne(
          spec.name,
          spec.fixture as FixtureName,
          spec.namespace,
          token,
          ctx,
        ),
      );
      const facts = await readAppFacts(ctx, spec.namespace, spec.name);
      if (facts === null) {
        throw new Error(
          `deployed app "${spec.name}" has no backend row - read-back failed`,
        );
      }
      await stampMarker(
        ctx,
        facts.pk,
        operation.desired as Resource<AppSpec>,
        "deployed",
      );
      ctx.identity.bind(operation.id, {
        pk: facts.pk,
        externalId: result.appId,
        ownerPk: facts.ownerPk,
        ...(facts.activeVersionPk !== null
          ? { activeVersionPk: facts.activeVersionPk }
          : {}),
      });
      return ok(operation.id, { appsDeployed: 1 });
    } catch (err) {
      return failed(operation.id, err);
    }
  });
}

async function deployOne(
  name: string,
  fixture: FixtureName,
  namespace: string,
  token: string,
  ctx: EngineContext,
): Promise<{ appId: string; url: string | null }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sim-app-"));
  try {
    writeFixtureApp(
      fixture === ("" as FixtureName) ? "static-site" : fixture,
      dir,
      name,
      namespace,
    );
    for (let attempt = 1; ; attempt++) {
      const result = await runWasmerDeploy(dir, {
        WASMER_REGISTRY: ctx.env["WASMER_REGISTRY"],
        WASMER_TOKEN: token,
        WASMER_NAMESPACE: namespace,
      });
      const jsonStart = result.stdout.indexOf("{");
      if (result.code === 0 && jsonStart !== -1) {
        const parsed = JSON.parse(result.stdout.slice(jsonStart)) as {
          url?: string;
          app?: { id?: string };
        };
        const appId = parsed.app?.id;
        if (appId === undefined) {
          throw new Error(`wasmer deploy for "${name}" returned no app id`);
        }
        return { appId, url: parsed.url ?? null };
      }
      // The CLI intermittently exits 0 with empty stdout under concurrent
      // deploys; both failure shapes are retried.
      if (attempt >= DEPLOY_ATTEMPTS) {
        throw new Error(
          result.code !== 0
            ? `wasmer deploy failed for "${name}" (exit ${result.code}): ${result.stderr.slice(-500)}`
            : `wasmer deploy for "${name}" produced no JSON output: ${result.stderr.slice(-300)}`,
        );
      }
      ctx.io.err(
        `apps: deploy of ${name} failed (attempt ${attempt}/${DEPLOY_ATTEMPTS}), retrying`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runWasmerDeploy(
  dir: string,
  env: Record<string, string>,
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
      stderr += chunk.toString();
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

async function readAppFacts(
  ctx: EngineContext,
  namespace: string,
  name: string,
): Promise<{
  pk: number;
  ownerPk: number;
  activeVersionPk: number | null;
} | null> {
  const result = await ctx.withPostgres((client) =>
    client.query<{
      id: number;
      owner_object_id: number;
      active_version_id: number | null;
    }>(
      `SELECT a.id, a.owner_object_id, a.active_version_id
         FROM deploy_deployapp a
         JOIN registry_namespace n ON n.id = a.owner_object_id AND n.name = $1
        WHERE a.name = $2 AND a.deleted_at IS NULL`,
      [namespace, name],
    ),
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        pk: row.id,
        ownerPk: row.owner_object_id,
        activeVersionPk: row.active_version_id,
      };
}

async function stampMarker(
  ctx: EngineContext,
  pk: number,
  desired: Resource<AppSpec>,
  realism: string,
): Promise<void> {
  await ctx.withPostgres((client) =>
    client.query(`UPDATE deploy_deployapp SET annotations = $1 WHERE id = $2`, [
      JSON.stringify(simMarker(ctx.scenario, desired.fingerprint, realism)),
      pk,
    ]),
  );
}

/** Fabricated apps: one transaction for the whole batch, each row carrying
 * the marker and a deterministic sim external id. */
async function fabricateApps(
  ops: Operation<AppSpec>[],
  ctx: EngineContext,
): Promise<OpResult[]> {
  if (ops.length === 0) {
    return [];
  }
  const contentType = await namespaceContentType(ctx);
  const domain = appDomain(ctx);
  try {
    return await inTransaction(ctx, async (client) => {
      const results: OpResult[] = [];
      for (const operation of ops) {
        const desired = operation.desired as Resource<AppSpec>;
        const spec = desired.spec;
        const namespacePk = ctx.identity.requireNumber(
          id("namespace", spec.namespace),
          "pk",
        );
        const ownerUserPk = ctx.identity.requireNumber(
          id("user", ctx.credentials.username),
          "pk",
        );
        const createdAt = new Date(
          Date.now() - spec.ageDays * 86_400_000,
        ).toISOString();
        const appRow = await client.query<{ id: number }>(
          `INSERT INTO deploy_deployapp
             (name, owner_object_id, owner_content_type_id, created_at, updated_at,
              created_by_id, state, external_id, force_https, hidden, managed,
              cdn_cache_enabled, annotations)
           VALUES ($1, $2, $3, $4, $4, $5, 'active:visible', $6, true, false, false, false, $7)
           RETURNING id`,
          [
            spec.name,
            namespacePk,
            contentType,
            createdAt,
            ownerUserPk,
            simExternalId("da", `${spec.namespace}/${spec.name}`),
            JSON.stringify(
              simMarker(ctx.scenario, desired.fingerprint, "fabricated"),
            ),
          ],
        );
        const appPk = appRow.rows[0].id;
        // The default deployment alias belongs to the app, not to the
        // declaration: its hostname is a platform fact.
        await client.query(
          `INSERT INTO deploy_appalias
             (name, is_default, app_id, hostname, kind, text, created_at, updated_at,
              state, external_id, is_added_by_ui)
           VALUES ($1, true, $2, $3, 'deployment', $4, $5, $5, 'verified', $6, false)`,
          [
            spec.name,
            appPk,
            domain,
            `${spec.name}.${domain}`,
            createdAt,
            simExternalId("daa", `${spec.namespace}/${spec.name}/default`),
          ],
        );
        ctx.identity.bind(operation.id, {
          pk: appPk,
          externalId: simExternalId("da", `${spec.namespace}/${spec.name}`),
          ownerPk: namespacePk,
        });
        results.push(ok(operation.id, { appsFabricated: 1 }));
      }
      return results;
    });
  } catch (err) {
    return ops.map((operation) => failed(operation.id, err));
  }
}

interface VersionRow {
  id: number;
  app_id: number;
  app_name: string;
  version_number: string;
  external_id: string | null;
  status: string | null;
  active: boolean;
}

export const appVersionAdapter: ResourceAdapter<AppVersionSpec> = {
  kind: "app-version",
  lane: "postgres",
  granularity: "group",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<AppVersionSpec>[]> {
    const namespaceId = id("namespace", scope.namespace);
    if (!ctx.identity.has(namespaceId)) {
      return [];
    }
    const namespacePk = ctx.identity.requireNumber(namespaceId, "pk");
    const rows = await ctx.withPostgres((client) =>
      client.query<VersionRow>(
        `SELECT v.id, v.app_id, a.name AS app_name, v.version_number, v.external_id,
                NULL AS status, (a.active_version_id = v.id) AS active
           FROM deploy_deployappversion v
           JOIN deploy_deployapp a ON a.id = v.app_id
          WHERE a.owner_object_id = $1
            AND a.deleted_at IS NULL
            AND a.annotations -> 'sim' ->> 'scenario' = $2
          ORDER BY a.name, v.version_number`,
        [namespacePk, scope.scenario],
      ),
    );
    // A failed deployment has a rollout but no version row, so it is
    // observed through its rollout. Within an app the failures are the
    // highest version numbers by construction (the expander declares them
    // that way), so creation order recovers the numbers exactly.
    const failures = await ctx.withPostgres((client) =>
      client.query<{ app_name: string; id: number }>(
        `SELECT a.name AS app_name, r.id
           FROM deploy_rollout r
           JOIN deploy_deployapp a ON a.id = r.deployapp_id
          WHERE a.owner_object_id = $1
            AND a.deleted_at IS NULL
            AND a.annotations -> 'sim' ->> 'scenario' = $2
            AND r.deployapp_version_id IS NULL
            AND r.status = 'failed'
          ORDER BY a.name, r.created_at, r.id`,
        [namespacePk, scope.scenario],
      ),
    );

    const observed: Array<Resource<AppVersionSpec>> = [];
    const highest = new Map<string, number>();
    for (const row of rows.rows) {
      const version = Number(row.version_number);
      highest.set(
        row.app_name,
        Math.max(highest.get(row.app_name) ?? 0, version),
      );
      const resourceId = id(
        "app-version",
        scope.namespace,
        row.app_name,
        String(version).padStart(4, "0"),
      );
      ctx.identity.bind(resourceId, { pk: row.id, appPk: row.app_id });
      observed.push(
        resource<AppVersionSpec>({
          id: resourceId,
          spec: {
            namespace: scope.namespace,
            app: row.app_name,
            version,
            active: row.active === true,
            failed: false,
            ageDays: 0,
          },
          fingerprintOf: {
            app: row.app_name,
            version,
            active: row.active === true,
            failed: false,
          },
        }),
      );
    }
    const failureIndex = new Map<string, number>();
    for (const row of failures.rows) {
      const offset = (failureIndex.get(row.app_name) ?? 0) + 1;
      failureIndex.set(row.app_name, offset);
      const version = (highest.get(row.app_name) ?? 0) + offset;
      const resourceId = id(
        "app-version",
        scope.namespace,
        row.app_name,
        String(version).padStart(4, "0"),
      );
      ctx.identity.bind(resourceId, { rolloutPk: row.id });
      observed.push(
        resource<AppVersionSpec>({
          id: resourceId,
          spec: {
            namespace: scope.namespace,
            app: row.app_name,
            version,
            active: false,
            failed: true,
            ageDays: 0,
          },
          fingerprintOf: {
            app: row.app_name,
            version,
            active: false,
            failed: true,
          },
        }),
      );
    }
    return observed;
  },

  diff(desired, observed) {
    // A really-deployed version is created by the deploy itself; the
    // reconciler never fabricates one on top of it.
    if (
      desired !== null &&
      observed === null &&
      desired.policy.realism === "deployed"
    ) {
      return [];
    }
    return defaultDiff("postgres", desired, observed);
  },

  async apply(
    ops: Operation<AppVersionSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    const creates = ops.filter((operation) => operation.type === "create");
    const deletes = ops.filter((operation) => operation.type === "delete");
    const results: OpResult[] = [];
    if (deletes.length > 0) {
      // A failed version is only a rollout row - it has no version PK to
      // delete, which is why the two are keyed apart here.
      const pks = deletes
        .filter((operation) => operation.observed?.spec.failed !== true)
        .map((operation) => ctx.identity.requireNumber(operation.id, "pk"));
      const rolloutPks = deletes
        .filter((operation) => operation.observed?.spec.failed === true)
        .map((operation) =>
          ctx.identity.requireNumber(operation.id, "rolloutPk"),
        );
      try {
        await inTransaction(ctx, async (client) => {
          if (rolloutPks.length > 0) {
            // A rollout can carry package rows that reference it.
            await client.query(
              `DELETE FROM deploy_packagerollout WHERE rollout_id = ANY($1::bigint[])`,
              [rolloutPks],
            );
            await client.query(
              `DELETE FROM deploy_rollout WHERE id = ANY($1::bigint[])`,
              [rolloutPks],
            );
          }
          if (pks.length === 0) {
            return;
          }
          await client.query(
            `UPDATE deploy_deployapp SET active_version_id = NULL WHERE active_version_id = ANY($1::bigint[])`,
            [pks],
          );
          for (const table of [
            "deploy_packagerollout",
            "deploy_githubrollout",
            "deploy_ziprollout",
            "deploy_build_times",
          ]) {
            await client.query(
              `DELETE FROM ${table} WHERE rollout_id IN
                 (SELECT id FROM deploy_rollout WHERE deployapp_version_id = ANY($1::bigint[]))`,
              [pks],
            );
          }
          await client.query(
            `DELETE FROM deploy_rollout WHERE deployapp_version_id = ANY($1::bigint[])`,
            [pks],
          );
          for (const table of [
            "deploy_appscreenshot",
            "deploy_nakeddeployment",
          ]) {
            await client.query(
              `DELETE FROM ${table} WHERE app_version_id = ANY($1::bigint[])`,
              [pks],
            );
          }
          await client.query(
            `DELETE FROM deploy_deployappversion WHERE id = ANY($1::bigint[])`,
            [pks],
          );
        });
        results.push(...deletes.map((operation) => ok(operation.id)));
      } catch (err) {
        results.push(...deletes.map((operation) => failed(operation.id, err)));
      }
    }
    if (creates.length === 0) {
      return results;
    }
    try {
      const created = await inTransaction(ctx, async (client) => {
        const perOp: OpResult[] = [];
        for (const operation of creates) {
          const desired = operation.desired as Resource<AppVersionSpec>;
          const spec = desired.spec;
          const appPk = ctx.identity.requireNumber(
            id("app", spec.namespace, spec.app),
            "pk",
          );
          const ownerUserPk = ctx.identity.requireNumber(
            id("user", ctx.credentials.username),
            "pk",
          );
          const createdAt = new Date(
            Date.now() - spec.ageDays * 86_400_000,
          ).toISOString();
          const yaml =
            `kind: wasmer.io/App.v0\nname: ${spec.app}\nowner: ${spec.namespace}\n` +
            "package: wasmer/static-web-server\n";
          let versionPk: number | null = null;
          if (!spec.failed) {
            // version_number is unique per app; a retried anchor deploy can
            // already hold more than one, so the fabricated numbers start
            // above whatever exists.
            const next = await client.query<{ max: string | null }>(
              `SELECT MAX(version_number) AS max FROM deploy_deployappversion WHERE app_id = $1`,
              [appPk],
            );
            const base = Math.max(
              Number(next.rows[0].max ?? 0),
              spec.version - 1,
            );
            const versionRow = await client.query<{ id: number }>(
              `INSERT INTO deploy_deployappversion
                 (version_number, created_at, updated_at, app_id, published_by_id,
                  yaml_config, user_yaml_config, client_name, external_id, disabled_permanently)
               VALUES ($1, $2, $2, $3, $4, $5, $5, 'simulator', $6, false)
               RETURNING id`,
              [
                base + 1,
                createdAt,
                appPk,
                ownerUserPk,
                yaml,
                simExternalId(
                  "dav",
                  `${spec.namespace}/${spec.app}/${spec.version}`,
                ),
              ],
            );
            versionPk = versionRow.rows[0].id;
            if (spec.active) {
              await client.query(
                `UPDATE deploy_deployapp SET active_version_id = $1 WHERE id = $2`,
                [versionPk, appPk],
              );
            }
          }
          await client.query(
            `INSERT INTO deploy_rollout
               (created_at, updated_at, status, deployapp_id, deployapp_version_id,
                rollout_type, external_id)
             VALUES ($1, $1, $2, $3, $4, 'package', $5)`,
            [
              createdAt,
              spec.failed ? "failed" : "success",
              appPk,
              versionPk,
              simExternalId(
                "dr",
                `${spec.namespace}/${spec.app}/${spec.version}`,
              ),
            ],
          );
          if (versionPk !== null) {
            ctx.identity.bind(operation.id, { pk: versionPk, appPk });
          }
          perOp.push(ok(operation.id, { versions: 1 }));
        }
        return perOp;
      });
      results.push(...created);
    } catch (err) {
      results.push(...creates.map((operation) => failed(operation.id, err)));
    }
    return results;
  },
};
