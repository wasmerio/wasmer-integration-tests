// Workload telemetry: the CPU/memory/network series behind the analytics
// page and the usage report. Unlike request rows, every value here is
// decided client-side by the model, so its digest carries exact sums and a
// drift of one hour is visible at level 1.

import { digestFingerprint } from "../digest";
import type { ResourceAdapter, Scope } from "../adapter";
import {
  id,
  type Digest,
  type OpResult,
  type Operation,
  type Resource,
} from "../model";
import type { DayDigestSpec, WorkloadBucketSpec } from "../specs";
import { mapConcurrent, type EngineContext } from "../engine/context";
import {
  insertWorkloadSummaries,
  SIM_NODE_UUID,
} from "../../seeders/telemetry";
import { clearBuckets, rebuildCoarserLevels } from "./rollups";
import {
  diffBucket,
  drillPredicate,
  ownerPkOf,
  parseDigestRows,
} from "./requests";
import { failed, ok } from "./common";

const HOUR_SEC = 3600;

export const workloadDayAdapter: ResourceAdapter<DayDigestSpec> = {
  kind: "workload-day",
  lane: "clickhouse",
  granularity: "group",
  virtual: true,

  async observe(): Promise<Resource<DayDigestSpec>[]> {
    return [];
  },

  async observeDigests(scope: Scope, ctx: EngineContext): Promise<Digest[]> {
    const ownerPk = ownerPkOf(ctx, scope);
    if (ownerPk === null) {
      return [];
    }
    const body = await ctx.clickhouse.query(
      `SELECT app_id,
              intDiv(toUnixTimestamp(grouped_at_hour), 86400) AS d,
              count() AS members,
              sum(wall_cpu_time_millis) AS cpuMillis,
              sum(memory_time_kbs) AS memoryTimeKbs,
              sum(wall_cpu_time_millis * (intDiv(toUnixTimestamp(grouped_at_hour) % 86400, 3600) + 1)) AS weighted
         FROM ${ctx.clickhouse.database}.workload_metrics_summary_hourly_by_owner_app_final
        WHERE app_owner_id = ${ownerPk} AND app_owner_is_user = 0
          AND grouped_at_hour >= toDateTime(${scope.fromSec})
          AND grouped_at_hour < toDateTime(${scope.toSec})
        GROUP BY app_id, d FORMAT TSV`,
    );
    return parseDigestRows(body, ctx, scope, "workload-day", [
      "cpuMillis",
      "memoryTimeKbs",
    ]);
  },

  diff() {
    return [];
  },

  async apply(): Promise<OpResult[]> {
    return [];
  },
};

export const workloadBucketAdapter: ResourceAdapter<WorkloadBucketSpec> = {
  kind: "workload-bucket",
  lane: "clickhouse",
  granularity: "bucket",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<WorkloadBucketSpec>[]> {
    const ownerPk = ownerPkOf(ctx, scope);
    const predicate = drillPredicate(scope, "grouped_at_hour");
    if (ownerPk === null || predicate === null) {
      return [];
    }
    const body = await ctx.clickhouse.query(
      `SELECT app_id, toUnixTimestamp(grouped_at_hour), wall_cpu_time_millis, memory_time_kbs,
              network_ingress_bytes, network_egress_bytes
         FROM ${ctx.clickhouse.database}.workload_metrics_summary_hourly_by_owner_app_final
        WHERE app_owner_id = ${ownerPk} AND app_owner_is_user = 0 AND ${predicate}
        FORMAT TSV`,
    );
    const observed: Array<Resource<WorkloadBucketSpec>> = [];
    for (const line of body.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const columns = line.split("\t");
      const appId = ctx.identity.byNative("app", "pk", Number(columns[0]));
      if (appId === undefined) {
        continue;
      }
      const epochHour = Math.floor(Number(columns[1]) / HOUR_SEC);
      observed.push({
        id: id(
          "workload-bucket",
          scope.namespace,
          appId.segments[1],
          String(epochHour).padStart(9, "0"),
        ),
        kind: "workload-bucket",
        spec: {
          namespace: scope.namespace,
          app: appId.segments[1],
          epochHour,
          cpuMillis: Number(columns[2]),
          memoryTimeKbs: Number(columns[3]),
          ingressKb: Math.round(Number(columns[4]) / 1024),
          egressKb: Math.round(Number(columns[5]) / 1024),
        },
        fingerprint: "",
        deps: [],
        policy: { prune: "delete" },
      });
    }
    observed.sort((a, b) =>
      a.id.segments.join("/") < b.id.segments.join("/") ? -1 : 1,
    );
    return observed;
  },

  diff(desired, observed, ctx) {
    // Memory-time drives the usage ring and CPU drives the analytics page,
    // and the two move independently: memory is per-hour residency while
    // CPU scales with traffic. Comparing their sum keeps the additive rule
    // one-sided (organic activity raises both) while still noticing a
    // declaration that changed only one of them.
    return diffBucket(
      desired,
      observed,
      ctx,
      (spec) => spec.memoryTimeKbs + spec.cpuMillis,
    );
  },

  async apply(
    ops: Operation<WorkloadBucketSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    const stats: Record<string, number> = {};
    const namespace =
      (ops[0].desired?.spec ?? ops[0].observed?.spec)?.namespace ?? "";
    const ownerPk = ctx.identity.requireNumber(
      id("namespace", namespace),
      "pk",
    );
    const clears = ops.filter(
      (operation) =>
        operation.type === "delete" ||
        operation.type === "replace" ||
        operation.type === "patch",
    );
    const writes = ops.filter((operation) => operation.type !== "delete");

    try {
      // A workload hour is a single summary row, not a stripe of requests,
      // so a shortfall is corrected by rewriting the hour rather than by
      // appending to it - otherwise the merged state would double-count.
      if (clears.length > 0) {
        await clearBuckets(
          ctx,
          {
            family: "workload",
            ownerPk,
            sets: hourSets(clears, ctx, namespace),
            externalIds: [],
            // A workload hour is one summary row, not a stripe of requests:
            // it is always rewritten whole, so the raw rows always go first.
            includeRaw: true,
          },
          stats,
        );
      }
      if (writes.length > 0) {
        const perApp = new Map<string, Operation<WorkloadBucketSpec>[]>();
        for (const operation of writes) {
          const app = (operation.desired as Resource<WorkloadBucketSpec>).spec
            .app;
          const list = perApp.get(app) ?? [];
          list.push(operation);
          perApp.set(app, list);
        }
        const outcomes = await mapConcurrent(
          [...perApp.entries()],
          ctx.workers.clickhouse,
          async ([app, appOps]) => {
            try {
              const appId = id("app", namespace, app);
              const native = ctx.identity.native(appId);
              const target = {
                appPk: ctx.identity.requireNumber(appId, "pk"),
                versionPk: Number(native?.["activeVersionPk"] ?? 0),
                externalId: ctx.identity.requireString(appId, "externalId"),
                name: app,
                share: 1,
              };
              const hours = appOps
                .map(
                  (operation) =>
                    (operation.desired as Resource<WorkloadBucketSpec>).spec,
                )
                .sort((a, b) => a.epochHour - b.epochHour)
                .map((spec) => ({
                  start: spec.epochHour * HOUR_SEC,
                  perApp: [
                    {
                      cpuMillis: spec.cpuMillis,
                      memoryTimeKbs: spec.memoryTimeKbs,
                      ingressKb: spec.ingressKb,
                      egressKb: spec.egressKb,
                    },
                  ],
                }));
              await insertWorkloadSummaries(
                ctx.clickhouse,
                { workloadHours: hours },
                target,
                0,
                ownerPk,
              );
              await insertSnapshots(ctx, target, hours, ownerPk);
              return { app, error: null as string | null };
            } catch (err) {
              return {
                app,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          },
        );
        const failures = new Map(
          outcomes
            .filter((entry) => entry.error !== null)
            .map((entry) => [entry.app, entry.error as string]),
        );
        if (failures.size > 0) {
          return ops.map((operation) => {
            const app =
              (operation.desired?.spec ?? operation.observed?.spec)?.app ?? "";
            const error = failures.get(app);
            return error === undefined
              ? ok(operation.id)
              : failed(operation.id, new Error(error));
          });
        }
        stats["workloadHours"] = writes.length;
      }
      if (clears.length > 0) {
        await rebuildCoarserLevels(
          ctx,
          {
            family: "workload",
            ownerPk,
            sets: hourSets(clears, ctx, namespace),
            externalIds: [],
            includeRaw: false,
          },
          stats,
        );
      }
      return ops.map((operation, index) =>
        ok(operation.id, index === 0 ? stats : undefined),
      );
    } catch (err) {
      return ops.map((operation) => failed(operation.id, err));
    }
  },
};

/** Gauge samples: six per hour, the shape v1 wrote and the instance view
 * reads. They belong to the hour they sample, so they are written with it. */
async function insertSnapshots(
  ctx: EngineContext,
  target: { appPk: number; versionPk: number; externalId: string },
  hours: Array<{
    start: number;
    perApp: Array<{
      cpuMillis: number;
      memoryTimeKbs: number;
      ingressKb: number;
      egressKb: number;
    }>;
  }>,
  ownerPk: number,
): Promise<void> {
  const recent = hours.filter(
    (hour) => hour.start * 1000 > Date.now() - 48 * 3_600_000,
  );
  if (recent.length === 0) {
    return;
  }
  const rows: string[] = [];
  for (const hour of recent) {
    const values = hour.perApp[0];
    for (let sample = 0; sample < 6; sample++) {
      rows.push(
        JSON.stringify({
          node_id: SIM_NODE_UUID,
          node_global_ipv4: "127.0.0.1",
          workload_id: workloadUuid(target.appPk),
          workload_type: "app",
          token_id: tokenUuid(ownerPk),
          agent: "sim",
          external_id: target.externalId,
          recorded_at: formatDateTime(hour.start + sample * 600),
          workload_created_at: formatDateTime(hour.start),
          network_ingress_gauge_bytes: values.ingressKb * 1024,
          network_egress_gauge_bytes: values.egressKb * 1024,
          cpu_time_gauge_millis: Math.round(
            (values.cpuMillis * (sample + 1)) / 6,
          ),
          memory_usage_gauge_bytes: Math.round(
            (values.memoryTimeKbs / 3600) * 1024,
          ),
          real_cpu_time_gauge_millis: Math.round(
            (values.cpuMillis * 1.18 * (sample + 1)) / 6,
          ),
          app_id: target.appPk,
          app_version_id: target.versionPk,
          app_owner_id: ownerPk,
          app_owner_is_user: false,
        }),
      );
    }
  }
  await ctx.clickhouse.query(
    `INSERT INTO ${ctx.clickhouse.database}.workload_metrics_snapshot FORMAT JSONEachRow\n${rows.join("\n")}`,
    300_000,
  );
}

function workloadUuid(appPk: number): string {
  return `99999999-5150-4e0d-1000-${appPk.toString(16).padStart(12, "0")}`;
}

function tokenUuid(ownerPk: number): string {
  return `99999999-5150-4e0d-2000-${ownerPk.toString(16).padStart(12, "0")}`;
}

function formatDateTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");
}

function hourSets<S extends { app: string; epochHour: number }>(
  ops: Operation<S>[],
  ctx: EngineContext,
  namespace: string,
): Array<{ appPk: number; hours: number[] }> {
  const perApp = new Map<number, number[]>();
  for (const operation of ops) {
    const spec = operation.desired?.spec ?? operation.observed?.spec;
    if (spec === undefined) {
      continue;
    }
    const appPk = ctx.identity.requireNumber(
      id("app", namespace, spec.app),
      "pk",
    );
    const hours = perApp.get(appPk) ?? [];
    hours.push(spec.epochHour);
    perApp.set(appPk, hours);
  }
  return [...perApp.entries()].map(([appPk, hours]) => ({ appPk, hours }));
}

export { digestFingerprint };
