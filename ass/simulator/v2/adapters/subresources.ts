// Custom domains, volumes, databases and cronjob definitions - the axes v1
// could not express at all.
//
// Ownership for these rows is a deterministic `sim`-marked external id plus
// membership in a marked app (section 8.1), because none of them carries a
// jsonb column. The predicate is generated into every statement.
//
// Cronjob definitions go through `createCronJob`, the API the product
// itself uses. Volumes and databases are direct writes: the backend has no
// volume mutation at all, and `createDatabaseAndLinkToApp` provisions real
// database infrastructure, which a simulated portfolio must not do - what
// is being declared is the record the dashboard reads, not a live server.

import { createHash } from "node:crypto";
import { defaultDiff, type ResourceAdapter, type Scope } from "../adapter";
import {
  id,
  resource,
  type OpResult,
  type Operation,
  type Resource,
} from "../model";
import type {
  CronjobSpec,
  DatabaseSpec,
  DomainSpec,
  VolumeSpec,
} from "../specs";
import type { EngineContext } from "../engine/context";
import {
  ensureUserClient,
  failed,
  inTransaction,
  isSimExternalId,
  ok,
  simExternalId,
} from "./common";

function managedAppFilter(scenario: string): string {
  return `a.deleted_at IS NULL AND a.annotations -> 'sim' ->> 'scenario' = '${scenario.replaceAll("'", "''")}'`;
}

/** Deterministic UUID for a volume: ClickHouse `volume_info.volume_id` is a
 * UUID, so the backend row and the usage series agree by construction. */
export function volumeUuid(resourceKey: string): string {
  const hex = createHash("sha1")
    .update(`sim-volume:${resourceKey}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const domainAdapter: ResourceAdapter<DomainSpec> = {
  kind: "domain",
  lane: "postgres",
  granularity: "group",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<DomainSpec>[]> {
    const namespaceId = id("namespace", scope.namespace);
    if (!ctx.identity.has(namespaceId)) {
      return [];
    }
    const rows = await ctx.withPostgres((client) =>
      client.query<{
        id: number;
        app_name: string;
        text: string;
        kind: string;
        external_id: string;
      }>(
        `SELECT al.id, a.name AS app_name, al.text, al.kind, al.external_id
           FROM deploy_appalias al
           JOIN deploy_deployapp a ON a.id = al.app_id
          WHERE a.owner_object_id = $1 AND ${managedAppFilter(scope.scenario)}
            AND al.kind = 'custom'
          ORDER BY a.name, al.text`,
        [ctx.identity.requireNumber(namespaceId, "pk")],
      ),
    );
    return rows.rows
      .filter((row) => isSimExternalId(row.external_id))
      .map((row) => {
        const resourceId = id(
          "domain",
          scope.namespace,
          row.app_name,
          row.text,
        );
        ctx.identity.bind(resourceId, { pk: row.id });
        return resource<DomainSpec>({
          id: resourceId,
          spec: {
            namespace: scope.namespace,
            app: row.app_name,
            fqdn: row.text,
            kind: "custom",
          },
        });
      });
  },

  diff(desired, observed) {
    return defaultDiff("postgres", desired, observed);
  },

  async apply(
    ops: Operation<DomainSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    return applyPostgresGroup(ops, ctx, {
      table: "deploy_appalias",
      async insert(client, operation) {
        const spec = (operation.desired as Resource<DomainSpec>).spec;
        const appPk = ctx.identity.requireNumber(
          id("app", spec.namespace, spec.app),
          "pk",
        );
        const row = await client.query<{ id: number }>(
          `INSERT INTO deploy_appalias
             (name, is_default, app_id, hostname, kind, text, created_at, updated_at,
              state, external_id, is_added_by_ui)
           VALUES ($1, false, $2, $1, 'custom', $1, NOW(), NOW(), 'verified', $3, true)
           RETURNING id`,
          [
            spec.fqdn,
            appPk,
            simExternalId("daa", `${spec.namespace}/${spec.app}/${spec.fqdn}`),
          ],
        );
        return row.rows[0].id;
      },
      stat: "domains",
    });
  },
};

export const volumeAdapter: ResourceAdapter<VolumeSpec> = {
  kind: "volume",
  lane: "postgres",
  granularity: "group",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<VolumeSpec>[]> {
    const namespaceId = id("namespace", scope.namespace);
    if (!ctx.identity.has(namespaceId)) {
      return [];
    }
    const rows = await ctx.withPostgres((client) =>
      client.query<{
        id: number;
        app_name: string;
        mount_path: string;
        max_size_bytes: string;
        volume_id: string;
        external_id: string;
      }>(
        `SELECT v.id, a.name AS app_name, v.mount_path, v.max_size_bytes, v.volume_id, v.external_id
           FROM deploy_appvolume v
           JOIN deploy_deployapp a ON a.id = v.app_id
          WHERE a.owner_object_id = $1 AND ${managedAppFilter(scope.scenario)}
            AND v.deleted_at IS NULL
          ORDER BY a.name, v.mount_path`,
        [ctx.identity.requireNumber(namespaceId, "pk")],
      ),
    );
    return rows.rows
      .filter((row) => isSimExternalId(row.external_id))
      .map((row) => {
        const resourceId = id(
          "volume",
          scope.namespace,
          row.app_name,
          row.mount_path,
        );
        ctx.identity.bind(resourceId, { pk: row.id, volumeId: row.volume_id });
        return resource<VolumeSpec>({
          id: resourceId,
          spec: {
            namespace: scope.namespace,
            app: row.app_name,
            mountPath: row.mount_path,
            maxSizeBytes: Number(row.max_size_bytes),
          },
        });
      });
  },

  diff(desired, observed) {
    return defaultDiff("postgres", desired, observed);
  },

  async apply(
    ops: Operation<VolumeSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    return applyPostgresGroup(ops, ctx, {
      table: "deploy_appvolume",
      async insert(client, operation) {
        const spec = (operation.desired as Resource<VolumeSpec>).spec;
        const appPk = ctx.identity.requireNumber(
          id("app", spec.namespace, spec.app),
          "pk",
        );
        const region = await client.query<{ id: number }>(
          "SELECT id FROM deploy_appregion ORDER BY id LIMIT 1",
        );
        if (region.rows.length === 0) {
          throw new Error(
            "volumes declared but the backend has no deploy_appregion row",
          );
        }
        const resourceKey = `${spec.namespace}/${spec.app}/${spec.mountPath}`;
        const uuid = volumeUuid(resourceKey);
        const row = await client.query<{ id: number }>(
          `INSERT INTO deploy_appvolume
             (created_at, updated_at, app_id, region_id, volume_id, mount_path,
              max_size_bytes, s3_enabled, is_added_by_ui, external_id)
           VALUES (NOW(), NOW(), $1, $2, $3, $4, $5, false, false, $6)
           RETURNING id`,
          [
            appPk,
            region.rows[0].id,
            uuid,
            spec.mountPath,
            spec.maxSizeBytes,
            simExternalId("dvol", resourceKey),
          ],
        );
        ctx.identity.bind(operation.id, { volumeId: uuid });
        return row.rows[0].id;
      },
      async update(client, operation) {
        const spec = (operation.desired as Resource<VolumeSpec>).spec;
        await client.query(
          `UPDATE deploy_appvolume SET max_size_bytes = $1, updated_at = NOW() WHERE id = $2`,
          [spec.maxSizeBytes, ctx.identity.requireNumber(operation.id, "pk")],
        );
      },
      stat: "volumes",
    });
  },
};

export const databaseAdapter: ResourceAdapter<DatabaseSpec> = {
  kind: "database",
  lane: "postgres",
  granularity: "group",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<DatabaseSpec>[]> {
    const namespaceId = id("namespace", scope.namespace);
    if (!ctx.identity.has(namespaceId)) {
      return [];
    }
    const rows = await ctx.withPostgres((client) =>
      client.query<{
        id: number;
        app_id: number;
        app_name: string;
        name: string;
        external_id: string | null;
      }>(
        `SELECT d.id, d.app_id, a.name AS app_name, d.name, d.external_id
           FROM deploy_appdatabase d
           JOIN deploy_deployapp a ON a.id = d.app_id
          WHERE a.owner_object_id = $1 AND ${managedAppFilter(scope.scenario)}
            AND d.deleted_at IS NULL
          ORDER BY a.name, d.name`,
        [ctx.identity.requireNumber(namespaceId, "pk")],
      ),
    );
    return rows.rows
      .filter((row) => isSimExternalId(row.external_id))
      .map((row) => {
        // The stored name carries the app PK so it can be globally unique
        // (a measured constraint); the declaration only ever sees the
        // declared part.
        const declaredName = declaredDatabaseName(row.name, row.app_id);
        const resourceId = id(
          "database",
          scope.namespace,
          row.app_name,
          declaredName,
        );
        ctx.identity.bind(resourceId, { pk: row.id });
        return resource<DatabaseSpec>({
          id: resourceId,
          spec: {
            namespace: scope.namespace,
            app: row.app_name,
            name: declaredName,
          },
        });
      });
  },

  diff(desired, observed) {
    return defaultDiff("postgres", desired, observed);
  },

  async apply(
    ops: Operation<DatabaseSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    return applyPostgresGroup(ops, ctx, {
      table: "deploy_appdatabase",
      async insert(client, operation) {
        const spec = (operation.desired as Resource<DatabaseSpec>).spec;
        const appPk = ctx.identity.requireNumber(
          id("app", spec.namespace, spec.app),
          "pk",
        );
        const resourceKey = `${spec.namespace}/${spec.app}/${spec.name}`;
        const storedName = storedDatabaseName(spec.name, appPk);
        const row = await client.query<{ id: number }>(
          `INSERT INTO deploy_appdatabase
             (created_at, updated_at, name, username, app_id, external_id)
           VALUES (NOW(), NOW(), $1, $2, $3, $4)
           RETURNING id`,
          [
            storedName,
            `${storedName}_user`,
            appPk,
            simExternalId("dadb", resourceKey),
          ],
        );
        return row.rows[0].id;
      },
      stat: "databases",
      async beforeDelete(client, pks) {
        await client.query(
          `DELETE FROM deploy_appdatabaseusagelog WHERE db_id = ANY($1::bigint[])`,
          [pks],
        );
      },
    });
  },
};

/** `deploy_appdatabase.name` and `.username` are globally unique (measured
 * on the live backend), so the stored name is qualified by the app PK. */
export function storedDatabaseName(declared: string, appPk: number): string {
  return `${declared}_${appPk}`;
}

export function declaredDatabaseName(stored: string, appPk: number): string {
  const suffix = `_${appPk}`;
  return stored.endsWith(suffix) ? stored.slice(0, -suffix.length) : stored;
}

export const cronjobAdapter: ResourceAdapter<CronjobSpec> = {
  kind: "cronjob",
  lane: "sdk",
  granularity: "group",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<CronjobSpec>[]> {
    const namespaceId = id("namespace", scope.namespace);
    if (!ctx.identity.has(namespaceId)) {
      return [];
    }
    const rows = await ctx.withPostgres((client) =>
      client.query<{
        id: number;
        app_name: string;
        name: string;
        schedule: string;
        kind: string;
        enabled: boolean;
        path: string | null;
        method: string | null;
      }>(
        `SELECT c.id, a.name AS app_name, c.name, c.schedule, c.kind, c.enabled,
                f.path, f.method
           FROM deploy_cronjob c
           JOIN django_content_type ct ON ct.id = c.owner_content_type_id
            AND ct.app_label = 'deploy' AND ct.model = 'deployapp'
           JOIN deploy_deployapp a ON a.id = c.owner_object_id
           LEFT JOIN deploy_cronjobfetchmeta f ON f.id = c.fetch_id
          WHERE a.owner_object_id = $1 AND ${managedAppFilter(scope.scenario)}
            AND c.deleted_at IS NULL
          ORDER BY a.name, c.name`,
        [ctx.identity.requireNumber(namespaceId, "pk")],
      ),
    );
    return rows.rows.map((row) => {
      const resourceId = id("cronjob", scope.namespace, row.app_name, row.name);
      ctx.identity.bind(resourceId, { pk: row.id });
      return resource<CronjobSpec>({
        id: resourceId,
        spec: {
          namespace: scope.namespace,
          app: row.app_name,
          name: row.name,
          schedule: row.schedule,
          kind: row.kind === "execute" ? "execute" : "fetch",
          enabled: row.enabled,
          path: row.path ?? "/cron",
          method: row.method ?? "GET",
        },
      });
    });
  },

  diff(desired, observed) {
    return defaultDiff("sdk", desired, observed);
  },

  async apply(
    ops: Operation<CronjobSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    const results: OpResult[] = [];
    const { client: user } = await ensureUserClient(ctx);
    for (const operation of ops) {
      try {
        if (operation.type === "delete" || operation.type === "update") {
          const pk = ctx.identity.requireNumber(operation.id, "pk");
          await ctx.withPostgres((client) =>
            client.query(
              `UPDATE deploy_cronjob SET deleted_at = NOW() WHERE id = $1`,
              [pk],
            ),
          );
          if (operation.type === "delete") {
            results.push(ok(operation.id));
            continue;
          }
        }
        const spec = (operation.desired as Resource<CronjobSpec>).spec;
        const appExternalId = ctx.identity.requireString(
          id("app", spec.namespace, spec.app),
          "externalId",
        );
        const created = await ctx.lanes.sdk.run(() =>
          user.gql<{ createCronJob: { cronJob: { id: string } } }>(
            `mutation($input: CreateCronJobInput!) {
               createCronJob(input: $input) { cronJob { id name } }
             }`,
            {
              input: {
                appId: appExternalId,
                name: spec.name,
                schedule: spec.schedule,
                enabled: spec.enabled,
                ...(spec.kind === "fetch"
                  ? { fetch: { path: spec.path, method: spec.method } }
                  : { execute: { command: "cron" } }),
              },
            },
          ),
        );
        ctx.identity.bind(operation.id, {
          externalId: created.createCronJob.cronJob.id,
        });
        results.push(ok(operation.id, { cronjobs: 1 }));
      } catch (err) {
        results.push(failed(operation.id, err));
      }
    }
    return results;
  },
};

interface GroupWriter<S> {
  table: string;
  insert(
    client: import("pg").PoolClient,
    operation: Operation<S>,
  ): Promise<number>;
  update?(
    client: import("pg").PoolClient,
    operation: Operation<S>,
  ): Promise<void>;
  beforeDelete?(client: import("pg").PoolClient, pks: number[]): Promise<void>;
  stat: string;
}

/** Every Postgres group kind writes the same way: one transaction for the
 * batch, deletes keyed on recorded PKs, inserts recording their bindings. */
async function applyPostgresGroup<S>(
  ops: Operation<S>[],
  ctx: EngineContext,
  writer: GroupWriter<S>,
): Promise<OpResult[]> {
  if (ops.length === 0) {
    return [];
  }
  const results: OpResult[] = [];
  try {
    await inTransaction(ctx, async (client) => {
      const deletes = ops.filter((operation) => operation.type === "delete");
      if (deletes.length > 0) {
        const pks = deletes.map((operation) =>
          ctx.identity.requireNumber(operation.id, "pk"),
        );
        await writer.beforeDelete?.(client, pks);
        await client.query(
          `DELETE FROM ${writer.table} WHERE id = ANY($1::bigint[])`,
          [pks],
        );
        results.push(...deletes.map((operation) => ok(operation.id)));
      }
      for (const operation of ops) {
        if (operation.type === "delete") {
          continue;
        }
        if (operation.type === "update" && writer.update !== undefined) {
          await writer.update(client, operation);
          results.push(ok(operation.id, { [writer.stat]: 1 }));
          continue;
        }
        if (operation.type === "update") {
          // No in-place update path: replace by delete + insert so the row
          // always matches the spec that produced it.
          await client.query(`DELETE FROM ${writer.table} WHERE id = $1`, [
            ctx.identity.requireNumber(operation.id, "pk"),
          ]);
        }
        const pk = await writer.insert(client, operation);
        ctx.identity.bind(operation.id, { pk });
        results.push(ok(operation.id, { [writer.stat]: 1 }));
      }
    });
  } catch (err) {
    return ops.map((operation) => failed(operation.id, err));
  }
  return results;
}
