// ClickHouse rollup surgery: how a bucket is removed or rewritten without
// destroying the neighbours that share its aggregate row.
//
// The hazard is structural. `request_log_hourly_by_owner_app` is per app,
// but `*_by_owner` and both `*_daily*` levels merge several apps and 24
// hours into one row, and a materialized view re-adds to every one of them
// on each insert. So a per-(app, hour) rewrite cannot simply delete and
// re-insert: it must rewrite the app level, then rebuild the coarser levels
// from it, and delete each coarser level only *after* the cascade that
// feeds it has finished. Getting this order wrong is the double-count v1's
// post-mortem describes, so it lives in one place with one entry point.
//
// Cost, measured on the live platform 2026-08-18: an `ALTER ... DELETE` is
// ~2.4 s on a rollup and ~6.5 s on unpartitioned `request_log`, regardless
// of how few rows it removes. Mutations are therefore coalesced per table
// and issued concurrently, and awaited only when the same plan writes the
// table again.

import { SIM_NODE_UUID } from "../../seeders/telemetry";
import type { EngineContext } from "../engine/context";

const HOUR_SEC = 3600;
const DAY_SEC = 86_400;

export interface HourSet {
  /** Backend PK of the app whose buckets are being rewritten. */
  appPk: number;
  /** Epoch hours, ascending. */
  hours: number[];
}

export function mergeRanges(sorted: number[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const value of sorted) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && value <= last[1] + 1) {
      last[1] = Math.max(last[1], value);
      continue;
    }
    ranges.push([value, value]);
  }
  return ranges;
}

function hourPredicate(column: string, hours: number[]): string {
  return mergeRanges([...hours].sort((a, b) => a - b))
    .map(
      ([from, to]) =>
        `(${column} >= toDateTime(${from * HOUR_SEC}) AND ${column} < toDateTime(${(to + 1) * HOUR_SEC}))`,
    )
    .join(" OR ");
}

function dayPredicate(column: string, days: number[]): string {
  return mergeRanges([...days].sort((a, b) => a - b))
    .map(
      ([from, to]) =>
        `(${column} >= toDateTime(${from * DAY_SEC}) AND ${column} < toDateTime(${(to + 1) * DAY_SEC}))`,
    )
    .join(" OR ");
}

export function daysOf(hours: number[]): number[] {
  return [...new Set(hours.map((hour) => Math.floor(hour / 24)))].sort(
    (a, b) => a - b,
  );
}

async function mutate(
  ctx: EngineContext,
  table: string,
  where: string,
  sync: 0 | 2,
  stats: Record<string, number>,
): Promise<void> {
  await ctx.clickhouse.query(
    `ALTER TABLE ${ctx.clickhouse.database}.${table} DELETE WHERE ${where} SETTINGS mutations_sync = ${sync}`,
    600_000,
  );
  stats[`mutation:${table}`] = (stats[`mutation:${table}`] ?? 0) + 1;
}

/** The aggregate-state columns of the request rollups, and how to re-derive
 * one level from the level below it. `-MergeState` merges the child states
 * and produces a parent state, which is exactly what the materialized view
 * would have produced. */
const REQUEST_STATE_COLUMNS = [
  ["http_total_count", "countMergeState"],
  ["cached_count", "sumMergeState"],
  ["http_2xx_count", "sumMergeState"],
  ["http_3xx_count", "sumMergeState"],
  ["http_4xx_count", "sumMergeState"],
  ["http_5xx_count", "sumMergeState"],
  ["http_other_count", "sumMergeState"],
  ["http_total_duration_millis", "sumMergeState"],
  ["unique_users_ipv6", "uniqCombined64MergeState"],
  ["total_data_served_bytes", "sumMergeState"],
  ["total_data_cached_bytes", "sumMergeState"],
  ["total_data_received_bytes", "sumMergeState"],
  ["edge_outcome_success", "sumMergeState"],
] as const;

const WORKLOAD_STATE_COLUMNS = [
  ["workloads_total", "countMergeState"],
  ["workloads_llvm", "sumMergeState"],
  ["workloads_cranelift", "sumMergeState"],
  ["wall_cpu_time_millis", "sumMergeState"],
  ["real_cpu_time_millis", "sumMergeState"],
  ["network_ingress_bytes", "sumMergeState"],
  ["network_egress_bytes", "sumMergeState"],
  ["memory_time_kbs", "sumMergeState"],
] as const;

export type Family = "request" | "workload";

interface FamilyTables {
  hourlyApp: string;
  hourlyOwner: string;
  dailyApp: string;
  dailyOwner: string;
  columns: ReadonlyArray<readonly [string, string]>;
  raw: string;
  rawTimeColumn: string;
  /** Extra raw-level table keyed by app external id, not by owner. */
  externalIdHourly?: string;
  /** Further owner-keyed raw tables cleared with the family (gauges). */
  extraRaw?: ReadonlyArray<readonly [string, string]>;
}

export const FAMILIES: Record<Family, FamilyTables> = {
  request: {
    hourlyApp: "request_log_hourly_by_owner_app",
    hourlyOwner: "request_log_hourly_by_owner",
    dailyApp: "request_log_daily_by_owner_app",
    dailyOwner: "request_log_daily_by_owner",
    columns: REQUEST_STATE_COLUMNS,
    raw: "request_log",
    rawTimeColumn: "received_at",
    externalIdHourly: "request_log_hourly",
  },
  workload: {
    hourlyApp: "workload_metrics_summary_hourly_by_owner_app",
    hourlyOwner: "workload_metrics_summary_hourly_by_owner",
    dailyApp: "workload_metrics_summary_daily_by_owner_app",
    dailyOwner: "workload_metrics_summary_daily_by_owner",
    columns: WORKLOAD_STATE_COLUMNS,
    raw: "workload_metrics_summary",
    rawTimeColumn: "recorded_at",
    // The gauge samples belong to the same hours as the summaries.
    extraRaw: [["workload_metrics_snapshot", "recorded_at"]],
  },
};

export interface RewriteRequest {
  family: Family;
  ownerPk: number;
  /** Per-app hour sets to clear before the writer re-inserts them. */
  sets: HourSet[];
  /** App external ids, for the one rollup keyed by external id. */
  externalIds: string[];
  /** True when raw rows for these hours must go too (teardown, or an
   * aggregate <- raw transition). */
  includeRaw: boolean;
  /** P3 demote (`raw -> aggregate`): the hour aged out of the raw window,
   * so its raw rows go and the states they already produced stay. P2 makes
   * those states exactly what the aggregate writer would have written, so
   * there is nothing to rewrite and nothing to rebuild. */
  rawOnly?: boolean;
}

/** Phase 1: clear the app level (and raw, when asked) for the given hours.
 * Coalesced to one mutation per table and awaited, because the writer's
 * inserts land immediately afterwards (A1). */
export async function clearBuckets(
  ctx: EngineContext,
  request: RewriteRequest,
  stats: Record<string, number>,
): Promise<void> {
  const tables = FAMILIES[request.family];
  const allHours = request.sets.flatMap((set) => set.hours);
  if (allHours.length === 0) {
    return;
  }
  const appClauses = request.sets
    .map(
      (set) =>
        `(app_id = ${set.appPk} AND (${hourPredicate("grouped_at_hour", set.hours)}))`,
    )
    .join(" OR ");
  const work: Array<Promise<void>> = [];
  if (request.rawOnly !== true) {
    work.push(
      mutate(
        ctx,
        tables.hourlyApp,
        `app_owner_id = ${request.ownerPk} AND app_owner_is_user = 0 AND (${appClauses})`,
        2,
        stats,
      ),
    );
  }
  if (request.includeRaw) {
    const rawClauses = request.sets
      .map(
        (set) =>
          `(app_id = ${set.appPk} AND (${hourPredicate(tables.rawTimeColumn, set.hours)}))`,
      )
      .join(" OR ");
    work.push(
      mutate(
        ctx,
        tables.raw,
        `app_owner_id = ${request.ownerPk} AND node_id = toUUID('${SIM_NODE_UUID}') AND (${rawClauses})`,
        2,
        stats,
      ),
    );
    if (
      tables.externalIdHourly !== undefined &&
      request.externalIds.length > 0
    ) {
      const ids = request.externalIds
        .map((value) => `'${value.replaceAll("'", "''")}'`)
        .join(",");
      work.push(
        mutate(
          ctx,
          tables.externalIdHourly,
          `external_id IN (${ids}) AND (${hourPredicate("grouped_at_hour", allHours)})`,
          2,
          stats,
        ),
      );
    }
  }
  await Promise.all(work);
}

/** Phase 2, after the writer's inserts have cascaded: rebuild the owner and
 * daily levels for the touched hours and days from the app level, which is
 * now correct. Each level is deleted only after everything that feeds it
 * has been written, so no materialized view can double-count. */
export async function rebuildCoarserLevels(
  ctx: EngineContext,
  request: RewriteRequest,
  stats: Record<string, number>,
): Promise<void> {
  const tables = FAMILIES[request.family];
  const hours = [...new Set(request.sets.flatMap((set) => set.hours))].sort(
    (a, b) => a - b,
  );
  if (hours.length === 0) {
    return;
  }
  const days = daysOf(hours);
  const columns = tables.columns;

  // Owner-hourly: rebuilt from every app of this owner for those hours.
  await mutate(
    ctx,
    tables.hourlyOwner,
    `app_owner_id = ${request.ownerPk} AND app_owner_is_user = 0 AND (${hourPredicate("grouped_at_hour", hours)})`,
    2,
    stats,
  );
  await ctx.clickhouse.query(
    `INSERT INTO ${ctx.clickhouse.database}.${tables.hourlyOwner}
       (app_owner_id, app_owner_is_user, grouped_at_hour, ${columns.map(([name]) => name).join(", ")})
     SELECT app_owner_id, app_owner_is_user, grouped_at_hour,
            ${columns.map(([name, combinator]) => `${combinator}(${name})`).join(", ")}
       FROM ${ctx.clickhouse.database}.${tables.hourlyApp}
      WHERE app_owner_id = ${request.ownerPk} AND app_owner_is_user = 0
        AND (${hourPredicate("grouped_at_hour", hours)})
      GROUP BY app_owner_id, app_owner_is_user, grouped_at_hour`,
    600_000,
  );

  // Daily levels: rebuilt from the *whole* day at the hourly level, because
  // a day row summarizes 24 hours and only some of them were rewritten.
  await Promise.all([
    (async () => {
      await mutate(
        ctx,
        tables.dailyApp,
        `app_owner_id = ${request.ownerPk} AND app_owner_is_user = 0 AND (${dayPredicate("grouped_at_day", days)})`,
        2,
        stats,
      );
      await ctx.clickhouse.query(
        `INSERT INTO ${ctx.clickhouse.database}.${tables.dailyApp}
           (app_owner_id, app_owner_is_user, app_id, grouped_at_day, ${columns.map(([name]) => name).join(", ")})
         SELECT app_owner_id, app_owner_is_user, app_id, toStartOfDay(grouped_at_hour),
                ${columns.map(([name, combinator]) => `${combinator}(${name})`).join(", ")}
           FROM ${ctx.clickhouse.database}.${tables.hourlyApp}
          WHERE app_owner_id = ${request.ownerPk} AND app_owner_is_user = 0
            AND (${dayPredicate("grouped_at_hour", days)})
          GROUP BY app_owner_id, app_owner_is_user, app_id, toStartOfDay(grouped_at_hour)`,
        600_000,
      );
    })(),
    (async () => {
      await mutate(
        ctx,
        tables.dailyOwner,
        `app_owner_id = ${request.ownerPk} AND app_owner_is_user = 0 AND (${dayPredicate("grouped_at_day", days)})`,
        2,
        stats,
      );
      await ctx.clickhouse.query(
        `INSERT INTO ${ctx.clickhouse.database}.${tables.dailyOwner}
           (app_owner_id, app_owner_is_user, grouped_at_day, ${columns.map(([name]) => name).join(", ")})
         SELECT app_owner_id, app_owner_is_user, toStartOfDay(grouped_at_hour),
                ${columns.map(([name, combinator]) => `${combinator}(${name})`).join(", ")}
           FROM ${ctx.clickhouse.database}.${tables.hourlyApp}
          WHERE app_owner_id = ${request.ownerPk} AND app_owner_is_user = 0
            AND (${dayPredicate("grouped_at_hour", days)})
          GROUP BY app_owner_id, app_owner_is_user, toStartOfDay(grouped_at_hour)`,
        600_000,
      );
    })(),
  ]);
}

/** Teardown: every level at once, keyed by owner. Nothing is rebuilt, so
 * order does not matter and all mutations run concurrently. */
export async function dropOwnerTelemetry(
  ctx: EngineContext,
  ownerPk: number,
  externalIds: string[],
  stats: Record<string, number>,
): Promise<void> {
  const owned = [
    ...Object.values(FAMILIES).flatMap((tables) => [
      tables.hourlyApp,
      tables.hourlyOwner,
      tables.dailyApp,
      tables.dailyOwner,
      tables.raw,
    ]),
    "workload_metrics_snapshot",
  ];
  await Promise.all([
    ...owned.map((table) =>
      mutate(
        ctx,
        table,
        `app_owner_id = ${ownerPk} AND app_owner_is_user = 0`,
        2,
        stats,
      ).catch(
        // `app_owner_is_user` is Bool on the raw tables and UInt8 on the
        // rollups; either way a failed drop is reported, never silent.
        () => mutate(ctx, table, `app_owner_id = ${ownerPk}`, 2, stats),
      ),
    ),
    externalIds.length === 0
      ? Promise.resolve()
      : mutate(
          ctx,
          "request_log_hourly",
          `external_id IN (${externalIds.map((value) => `'${value.replaceAll("'", "''")}'`).join(",")})`,
          2,
          stats,
        ),
  ]);
}
