// Usage series: volume size over time (ClickHouse `volume_info`), database
// size over time (Postgres `deploy_appdatabaseusagelog`) and the hourly
// usage snapshots the usage page sums.
//
// These are exact, client-decided values - nothing organic writes them on a
// local platform - so they diff two-sided by fingerprint, unlike request
// traffic.

import { defaultDiff, type ResourceAdapter, type Scope } from "../adapter";
import {
  id,
  resource,
  type OpResult,
  type Operation,
  type Resource,
} from "../model";
import {
  usagePeriodFingerprint,
  type DatabaseUsageSpec,
  type UsagePeriodSpec,
  type VolumeUsageSpec,
} from "../specs";
import type { EngineContext } from "../engine/context";
import { SIM_NODE_UUID } from "../../seeders/telemetry";
import { failed, inTransaction, namespaceContentType, ok } from "./common";
import { declaredDatabaseName } from "./subresources";

const HOUR_SEC = 3600;

export const volumeUsageAdapter: ResourceAdapter<VolumeUsageSpec> = {
  kind: "volume-usage",
  lane: "clickhouse",
  granularity: "bucket",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<VolumeUsageSpec>[]> {
    const volumes = knownVolumes(ctx, scope);
    if (volumes.length === 0) {
      return [];
    }
    const ids = volumes.map((entry) => `toUUID('${entry.volumeId}')`).join(",");
    const body = await ctx.clickhouse.query(
      `SELECT toString(volume_id), toUnixTimestamp(timestamp), size
         FROM ${ctx.clickhouse.database}.volume_info
        WHERE node_id = toUUID('${SIM_NODE_UUID}') AND volume_id IN (${ids})
        ORDER BY volume_id, timestamp FORMAT TSV`,
    );
    const byUuid = new Map(volumes.map((entry) => [entry.volumeId, entry]));
    const observed: Array<Resource<VolumeUsageSpec>> = [];
    for (const line of body.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const [uuid, ts, size] = line.split("\t");
      const volume = byUuid.get(uuid);
      if (volume === undefined) {
        continue;
      }
      const epochHour = Math.floor(Number(ts) / HOUR_SEC);
      observed.push(
        resource<VolumeUsageSpec>({
          id: id(
            "volume-usage",
            scope.namespace,
            volume.app,
            volume.mountPath,
            String(epochHour).padStart(9, "0"),
          ),
          spec: {
            namespace: scope.namespace,
            app: volume.app,
            mountPath: volume.mountPath,
            epochHour,
            sizeBytes: Number(size),
          },
        }),
      );
    }
    observed.sort((a, b) =>
      a.id.segments.join("/") < b.id.segments.join("/") ? -1 : 1,
    );
    return observed;
  },

  diff(desired, observed) {
    return defaultDiff("clickhouse", desired, observed);
  },

  async apply(
    ops: Operation<VolumeUsageSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    const stats: Record<string, number> = {};
    const deletes = ops.filter(
      (operation) => operation.type === "delete" || operation.type === "update",
    );
    const writes = ops.filter((operation) => operation.type !== "delete");
    try {
      if (deletes.length > 0) {
        const uuids = [
          ...new Set(
            deletes.map((operation) => {
              const spec = (operation.observed?.spec ??
                operation.desired?.spec) as VolumeUsageSpec;
              return ctx.identity.requireString(
                id("volume", spec.namespace, spec.app, spec.mountPath),
                "volumeId",
              );
            }),
          ),
        ];
        const hours = deletes.map(
          (operation) =>
            (
              (operation.observed?.spec ??
                operation.desired?.spec) as VolumeUsageSpec
            ).epochHour,
        );
        await ctx.clickhouse.query(
          `ALTER TABLE ${ctx.clickhouse.database}.volume_info DELETE
             WHERE node_id = toUUID('${SIM_NODE_UUID}')
               AND volume_id IN (${uuids.map((value) => `toUUID('${value}')`).join(",")})
               AND timestamp >= toDateTime(${Math.min(...hours) * HOUR_SEC})
               AND timestamp < toDateTime(${(Math.max(...hours) + 1) * HOUR_SEC})
             SETTINGS mutations_sync = 2`,
          600_000,
        );
        stats["mutation:volume_info"] = 1;
      }
      if (writes.length > 0) {
        // `volume_info` is a plain MergeTree: inserting the same hour twice
        // doubles it silently. The range is cleared first so a write is
        // idempotent by construction rather than by hoping.
        const writeUuids = [
          ...new Set(
            writes.map((operation) => {
              const spec = (operation.desired as Resource<VolumeUsageSpec>)
                .spec;
              return ctx.identity.requireString(
                id("volume", spec.namespace, spec.app, spec.mountPath),
                "volumeId",
              );
            }),
          ),
        ];
        const writeHours = writes.map(
          (operation) =>
            (operation.desired as Resource<VolumeUsageSpec>).spec.epochHour,
        );
        await ctx.clickhouse.query(
          `ALTER TABLE ${ctx.clickhouse.database}.volume_info DELETE
             WHERE node_id = toUUID('${SIM_NODE_UUID}')
               AND volume_id IN (${writeUuids.map((value) => `toUUID('${value}')`).join(",")})
               AND timestamp >= toDateTime(${Math.min(...writeHours) * HOUR_SEC})
               AND timestamp < toDateTime(${(Math.max(...writeHours) + 1) * HOUR_SEC})
             SETTINGS mutations_sync = 2`,
          600_000,
        );
        stats["mutation:volume_info"] = 1;
        const rows = writes.map((operation) => {
          const spec = (operation.desired as Resource<VolumeUsageSpec>).spec;
          return JSON.stringify({
            node_global_ipv4: "127.0.0.1",
            node_id: SIM_NODE_UUID,
            volume_id: ctx.identity.requireString(
              id("volume", spec.namespace, spec.app, spec.mountPath),
              "volumeId",
            ),
            size: spec.sizeBytes,
            timestamp: new Date(spec.epochHour * HOUR_SEC * 1000)
              .toISOString()
              .replace("T", " ")
              .replace("Z", ""),
            iops_read: 0,
            iops_write: 0,
          });
        });
        await ctx.clickhouse.query(
          `INSERT INTO ${ctx.clickhouse.database}.volume_info FORMAT JSONEachRow\n${rows.join("\n")}`,
          300_000,
        );
        stats["volumeUsageRows"] = rows.length;
      }
      return ops.map((operation, index) =>
        ok(operation.id, index === 0 ? stats : undefined),
      );
    } catch (err) {
      return ops.map((operation) => failed(operation.id, err));
    }
  },
};

function knownVolumes(
  ctx: EngineContext,
  scope: Scope,
): Array<{ app: string; mountPath: string; volumeId: string }> {
  const volumes: Array<{ app: string; mountPath: string; volumeId: string }> =
    [];
  for (const entry of ctx.identity.toJSON()) {
    if (!entry.key.startsWith("volume:")) {
      continue;
    }
    const segments = entry.key.slice("volume:".length).split("/");
    const volumeId = entry.native["volumeId"];
    if (segments[0] !== scope.namespace || volumeId === undefined) {
      continue;
    }
    volumes.push({
      app: segments[1],
      mountPath: segments.slice(2).join("/"),
      volumeId: String(volumeId),
    });
  }
  return volumes;
}

export const databaseUsageAdapter: ResourceAdapter<DatabaseUsageSpec> = {
  kind: "database-usage",
  lane: "postgres",
  granularity: "bucket",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<DatabaseUsageSpec>[]> {
    const namespaceId = id("namespace", scope.namespace);
    if (!ctx.identity.has(namespaceId)) {
      return [];
    }
    const rows = await ctx.withPostgres((client) =>
      client.query<{
        app_name: string;
        db_name: string;
        app_id: number;
        checked_at: Date;
        usage_bytes: string;
      }>(
        `SELECT a.name AS app_name, d.name AS db_name, d.app_id, l.checked_at, l.usage_bytes
           FROM deploy_appdatabaseusagelog l
           JOIN deploy_appdatabase d ON d.id = l.db_id
           JOIN deploy_deployapp a ON a.id = d.app_id
          WHERE a.owner_object_id = $1 AND a.deleted_at IS NULL
            AND a.annotations -> 'sim' ->> 'scenario' = $2
          ORDER BY a.name, d.name, l.checked_at`,
        [ctx.identity.requireNumber(namespaceId, "pk"), scope.scenario],
      ),
    );
    return rows.rows.map((row) => {
      const epochHour = Math.floor(row.checked_at.getTime() / 1000 / HOUR_SEC);
      const database = declaredDatabaseName(row.db_name, row.app_id);
      return resource<DatabaseUsageSpec>({
        id: id(
          "database-usage",
          scope.namespace,
          row.app_name,
          database,
          String(epochHour).padStart(9, "0"),
        ),
        spec: {
          namespace: scope.namespace,
          app: row.app_name,
          database,
          epochHour,
          usageBytes: Number(row.usage_bytes),
        },
      });
    });
  },

  diff(desired, observed) {
    return defaultDiff("postgres", desired, observed);
  },

  async apply(
    ops: Operation<DatabaseUsageSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    const writes = ops.filter((operation) => operation.type !== "delete");
    const deletes = ops.filter(
      (operation) => operation.type === "delete" || operation.type === "update",
    );
    try {
      await inTransaction(ctx, async (client) => {
        for (const operation of deletes) {
          const spec = (operation.observed?.spec ??
            operation.desired?.spec) as DatabaseUsageSpec;
          await client.query(
            `DELETE FROM deploy_appdatabaseusagelog
              WHERE db_id = $1 AND checked_at = to_timestamp($2)`,
            [
              ctx.identity.requireNumber(
                id("database", spec.namespace, spec.app, spec.database),
                "pk",
              ),
              spec.epochHour * HOUR_SEC,
            ],
          );
        }
        // Idempotent by construction: the log table has no unique key, so
        // the written range is cleared before it is written.
        if (writes.length > 0) {
          const dbPks = [
            ...new Set(
              writes.map((operation) => {
                const spec = (operation.desired as Resource<DatabaseUsageSpec>)
                  .spec;
                return ctx.identity.requireNumber(
                  id("database", spec.namespace, spec.app, spec.database),
                  "pk",
                );
              }),
            ),
          ];
          const hours = writes.map(
            (operation) =>
              (operation.desired as Resource<DatabaseUsageSpec>).spec.epochHour,
          );
          await client.query(
            `DELETE FROM deploy_appdatabaseusagelog
              WHERE db_id = ANY($1::bigint[])
                AND checked_at >= to_timestamp($2) AND checked_at < to_timestamp($3)`,
            [
              dbPks,
              Math.min(...hours) * HOUR_SEC,
              (Math.max(...hours) + 1) * HOUR_SEC,
            ],
          );
        }
        // One multi-row insert per chunk: the series is thousands of rows
        // and a statement per row would dominate the reconcile.
        const CHUNK = 500;
        for (let offset = 0; offset < writes.length; offset += CHUNK) {
          const chunk = writes.slice(offset, offset + CHUNK);
          const values: string[] = [];
          const params: unknown[] = [];
          for (const operation of chunk) {
            const spec = (operation.desired as Resource<DatabaseUsageSpec>)
              .spec;
            const base = params.length;
            values.push(
              `($${base + 1}, to_timestamp($${base + 2}), $${base + 3})`,
            );
            params.push(
              ctx.identity.requireNumber(
                id("database", spec.namespace, spec.app, spec.database),
                "pk",
              ),
              spec.epochHour * HOUR_SEC,
              spec.usageBytes,
            );
          }
          await client.query(
            `INSERT INTO deploy_appdatabaseusagelog (db_id, checked_at, usage_bytes) VALUES ${values.join(",")}`,
            params,
          );
        }
      });
      return ops.map((operation, index) =>
        ok(
          operation.id,
          index === 0 ? { databaseUsageRows: writes.length } : undefined,
        ),
      );
    } catch (err) {
      return ops.map((operation) => failed(operation.id, err));
    }
  },
};

export const usagePeriodAdapter: ResourceAdapter<UsagePeriodSpec> = {
  kind: "usage-period",
  lane: "postgres",
  granularity: "bucket",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<UsagePeriodSpec>[]> {
    const namespaceId = id("namespace", scope.namespace);
    if (!ctx.identity.has(namespaceId)) {
      return [];
    }
    const contentType = await namespaceContentType(ctx);
    const rows = await ctx.withPostgres((client) =>
      client.query<{
        id: number;
        snapshot_started_at: Date;
        snapshot_ended_at: Date;
        resolution: string;
        no_requests: string;
        network_ingress_bytes: string;
        network_egress_bytes: string;
        cpu_time_hours: number;
        memory_time_gbh: number;
        app_count: string;
        domain_count: string;
        volume_storage_bytes: string;
        db_storage_bytes: string;
      }>(
        `SELECT id, snapshot_started_at, snapshot_ended_at, resolution, no_requests,
                network_ingress_bytes, network_egress_bytes, cpu_time_hours, memory_time_gbh,
                app_count, domain_count, volume_storage_bytes, db_storage_bytes
           FROM usage_metrics_periodicusagesnapshot
          WHERE owner_content_type_id = $1 AND owner_object_id = $2 AND source = 'manual'
            AND snapshot_started_at >= to_timestamp($3) AND snapshot_started_at < to_timestamp($4)
          ORDER BY snapshot_started_at`,
        [
          contentType,
          ctx.identity.requireNumber(namespaceId, "pk"),
          scope.fromSec,
          scope.toSec,
        ],
      ),
    );
    return rows.rows.map((row) => {
      const startSec = Math.floor(row.snapshot_started_at.getTime() / 1000);
      const spec: UsagePeriodSpec = {
        namespace: scope.namespace,
        resolution: row.resolution,
        startSec,
        endSec: Math.floor(row.snapshot_ended_at.getTime() / 1000),
        requests: Number(row.no_requests),
        memoryGbh: Number(row.memory_time_gbh),
        cpuHours: Number(row.cpu_time_hours),
        ingressBytes: Number(row.network_ingress_bytes),
        egressBytes: Number(row.network_egress_bytes),
        appCount: Number(row.app_count),
        domainCount: Number(row.domain_count),
        volumeBytes: Number(row.volume_storage_bytes),
        dbBytes: Number(row.db_storage_bytes),
      };
      const resourceId = id(
        "usage-period",
        scope.namespace,
        row.resolution,
        String(Math.floor(startSec / HOUR_SEC)).padStart(9, "0"),
      );
      ctx.identity.bind(resourceId, { pk: row.id });
      return {
        id: resourceId,
        kind: "usage-period" as const,
        spec,
        fingerprint: usagePeriodFingerprint(spec),
        deps: [],
        policy: { prune: "delete" as const },
      };
    });
  },

  diff(desired, observed) {
    return defaultDiff("postgres", desired, observed);
  },

  async apply(
    ops: Operation<UsagePeriodSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    const contentType = await namespaceContentType(ctx);
    const namespace =
      (ops[0].desired?.spec ?? ops[0].observed?.spec)?.namespace ?? "";
    const ownerPk = ctx.identity.requireNumber(
      id("namespace", namespace),
      "pk",
    );
    const deletes = ops.filter((operation) => operation.type === "delete");
    const upserts = ops.filter((operation) => operation.type !== "delete");
    try {
      await inTransaction(ctx, async (client) => {
        if (deletes.length > 0) {
          const pks = deletes.map((operation) =>
            ctx.identity.requireNumber(operation.id, "pk"),
          );
          await client.query(
            `DELETE FROM usage_metrics_periodicusagesnapshot WHERE id = ANY($1::bigint[])`,
            [pks],
          );
        }
        const CHUNK = 400;
        for (let offset = 0; offset < upserts.length; offset += CHUNK) {
          const chunk = upserts.slice(offset, offset + CHUNK);
          const values: string[] = [];
          const params: unknown[] = [];
          for (const operation of chunk) {
            const spec = (operation.desired as Resource<UsagePeriodSpec>).spec;
            const base = params.length;
            values.push(
              `(NOW(), to_timestamp($${base + 1}), to_timestamp($${base + 2}), $${base + 3}, ${contentType}, ${ownerPk},
                $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10},
                0, $${base + 11}, 0, $${base + 12}, 0, 0, 'manual')`,
            );
            params.push(
              spec.startSec,
              spec.endSec,
              spec.resolution,
              spec.requests,
              spec.ingressBytes,
              spec.egressBytes,
              spec.cpuHours,
              spec.memoryGbh,
              spec.appCount,
              spec.domainCount,
              spec.volumeBytes,
              spec.dbBytes,
            );
          }
          // The measured unique index is (owner ct, owner id, both period
          // bounds, resolution) - the natural key the doc's section 3.3
          // records, not a bare hour.
          await client.query(
            `INSERT INTO usage_metrics_periodicusagesnapshot
               (created_at, snapshot_started_at, snapshot_ended_at, resolution,
                owner_content_type_id, owner_object_id, no_requests,
                network_ingress_bytes, network_egress_bytes, cpu_time_hours,
                memory_time_gbh, app_count, domain_count, build_minutes,
                volume_storage_bytes, package_storage_bytes, db_storage_bytes,
                member_count, email_sent, source)
             VALUES ${values.join(",")}
             ON CONFLICT (owner_content_type_id, owner_object_id, snapshot_started_at,
                          snapshot_ended_at, resolution)
             DO UPDATE SET no_requests = EXCLUDED.no_requests,
                           network_ingress_bytes = EXCLUDED.network_ingress_bytes,
                           network_egress_bytes = EXCLUDED.network_egress_bytes,
                           cpu_time_hours = EXCLUDED.cpu_time_hours,
                           memory_time_gbh = EXCLUDED.memory_time_gbh,
                           app_count = EXCLUDED.app_count,
                           domain_count = EXCLUDED.domain_count,
                           volume_storage_bytes = EXCLUDED.volume_storage_bytes,
                           db_storage_bytes = EXCLUDED.db_storage_bytes`,
            params,
          );
        }
      });
      return ops.map((operation, index) =>
        ok(
          operation.id,
          index === 0 ? { usagePeriods: upserts.length } : undefined,
        ),
      );
    } catch (err) {
      return ops.map((operation) => failed(operation.id, err));
    }
  },
};
