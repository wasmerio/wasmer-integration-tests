// Telemetry writer (spec §3.2, D-A/D-B as resolved by the 2026-08-14
// read-path verification): the dashboard reads *only* the daily rollup
// views (request_log_daily_by_owner_final, workload_metrics_summary_daily_
// by_owner_final — captured from system.query_log), and every rollup is
// fed by insert-time materialized-view cascades. Scale therefore comes from
// exact server-side aggregate inserts into request_log_hourly_by_owner_app
// (which cascade to the daily/by-owner rollups), with per-request raw rows
// only inside the recent `rawWindow`; raw inserts cascade into the same
// rollups, so totals stay exact end to end. Counts are decided client-side
// by the seeded model and recorded in the descriptor, so the plan, the
// database, and Phase 6's assertions share one set of numbers.

import { SimulatorClickHouse } from "../clients/clickhouse";
import {
  assertTableColumns,
  connectSimulatorPostgres,
} from "../clients/postgres";
import { parseDurationMs } from "../schema";
import type { SimulatorDeclaration, TelemetryBlock } from "../schema";
import {
  expandTraffic,
  resolvePerAppMultipliers,
  serverSideErrorCount,
  type TrafficModel,
} from "../traffic";
import { appNames } from "../names";
import {
  SeedPlanError,
  type EmitEntry,
  type SeedContext,
  type Seeder,
} from "../registry";

/** D-A default: raw request rows the writer may create. */
export const DEFAULT_ROW_BUDGET = 25_000_000;
/** Backstop on server-side generated request volume (virtual rows). */
export const GENERATION_CEILING = 2_000_000_000;

/** Exported for the v2 engine: raw-level ownership is this node id. */
export const SIM_NODE_UUID = "99999999-5150-4e0d-0000-000000000001";

/** Expected columns of every table this writer inserts into (D-B). Types
 * are live `DESCRIBE TABLE` values captured 2026-08-14. */
export const TELEMETRY_TABLES: Record<string, Record<string, string>> = {
  request_log: {
    node_id: "UUID",
    node_global_ipv4: "IPv4",
    workload_id: "UUID",
    request_id: "UUID",
    external_id: "LowCardinality(String)",
    received_at: "DateTime64(3)",
    total_duration_microseconds: "UInt64",
    client_ipv4: "IPv4",
    http_version: "LowCardinality(String)",
    http_method: "LowCardinality(String)",
    request_domain: "LowCardinality(String)",
    url_path: "LowCardinality(String)",
    outcome: "LowCardinality(String)",
    response_http_status: "UInt16",
    request_body_size: "UInt64",
    response_from_cache: "Bool",
    response_body_size: "UInt64",
    app_id: "UInt64",
    app_version_id: "UInt64",
    app_owner_id: "UInt64",
    app_owner_is_user: "Bool",
    protocol: "LowCardinality(String)",
  },
  request_log_hourly_by_owner_app: {
    app_owner_id: "UInt64",
    app_owner_is_user: "UInt8",
    app_id: "UInt64",
    grouped_at_hour: "DateTime",
    http_total_count: "AggregateFunction(count)",
    cached_count: "AggregateFunction(sum, UInt64)",
    http_2xx_count: "AggregateFunction(sum, UInt64)",
    http_3xx_count: "AggregateFunction(sum, UInt64)",
    http_4xx_count: "AggregateFunction(sum, UInt64)",
    http_5xx_count: "AggregateFunction(sum, UInt64)",
    http_other_count: "AggregateFunction(sum, UInt64)",
    http_total_duration_millis: "AggregateFunction(sum, UInt64)",
    unique_users_ipv6: "AggregateFunction(uniqCombined64, UInt64)",
    total_data_served_bytes: "AggregateFunction(sum, UInt64)",
    total_data_cached_bytes: "AggregateFunction(sum, UInt64)",
    total_data_received_bytes: "AggregateFunction(sum, UInt64)",
    edge_outcome_success: "AggregateFunction(sum, UInt8)",
  },
  workload_metrics_summary: {
    node_id: "UUID",
    node_global_ipv4: "IPv4",
    workload_id: "UUID",
    workload_type: "LowCardinality(String)",
    token_id: "UUID",
    agent: "LowCardinality(String)",
    external_id: "LowCardinality(String)",
    created_at: "DateTime64(3)",
    started_at: "DateTime64(3)",
    completed_at: "DateTime64(3)",
    network_ingress_kb: "UInt64",
    network_egress_kb: "UInt64",
    memory_time_kbs: "UInt64",
    cpu_time_millis: "UInt64",
    status: "LowCardinality(String)",
    engine: "LowCardinality(String)",
    real_cpu_time_millis: "UInt64",
    app_id: "UInt64",
    app_version_id: "UInt64",
    app_owner_id: "UInt64",
    app_owner_is_user: "Bool",
    recorded_at: "DateTime64(3)",
  },
  workload_metrics_snapshot: {
    node_id: "UUID",
    node_global_ipv4: "IPv4",
    workload_id: "UUID",
    workload_type: "LowCardinality(String)",
    token_id: "UUID",
    agent: "LowCardinality(String)",
    external_id: "LowCardinality(String)",
    recorded_at: "DateTime64(3)",
    workload_created_at: "DateTime64(3)",
    network_ingress_gauge_bytes: "UInt64",
    network_egress_gauge_bytes: "UInt64",
    cpu_time_gauge_millis: "UInt64",
    memory_usage_gauge_bytes: "UInt64",
    real_cpu_time_gauge_millis: "UInt64",
    app_id: "UInt64",
    app_version_id: "UInt64",
    app_owner_id: "UInt64",
    app_owner_is_user: "Bool",
  },
};

/** Owner-keyed tables the teardown deletes; `request_log_hourly` is keyed
 * by app external_id instead (no owner column — verified live). */
export const OWNER_KEYED_TABLES = [
  "request_log",
  "request_log_hourly_by_owner",
  "request_log_hourly_by_owner_app",
  "request_log_daily_by_owner",
  "request_log_daily_by_owner_app",
  "workload_metrics_summary",
  "workload_metrics_summary_hourly_by_owner",
  "workload_metrics_summary_hourly_by_owner_app",
  "workload_metrics_summary_daily_by_owner",
  "workload_metrics_summary_daily_by_owner_app",
  "workload_metrics_snapshot",
];

/** The usage page's `used` figures sum this Postgres table (hourly rows in
 * the billing window; `manual` source so the backend's own sweep cursor
 * never sees them). Written here because the values must agree with the
 * ClickHouse history to the row. */
export const USAGE_SNAPSHOT_TABLE = "usage_metrics_periodicusagesnapshot";
export const USAGE_SNAPSHOT_COLUMNS: Record<string, string> = {
  id: "bigint",
  created_at: "timestamp with time zone",
  snapshot_started_at: "timestamp with time zone",
  snapshot_ended_at: "timestamp with time zone",
  resolution: "character varying",
  owner_content_type_id: "integer",
  owner_object_id: "integer",
  no_requests: "numeric",
  network_ingress_bytes: "numeric",
  network_egress_bytes: "numeric",
  cpu_time_hours: "double precision",
  memory_time_gbh: "double precision",
  app_count: "bigint",
  domain_count: "bigint",
  build_minutes: "double precision",
  volume_storage_bytes: "numeric",
  package_storage_bytes: "numeric",
  db_storage_bytes: "numeric",
  member_count: "bigint",
  email_sent: "bigint",
  source: "text",
};

export interface ClickHouseRowsEntry {
  kind: "clickhouse-rows";
  ownerId: number;
  appExternalIds: string[];
  from: string;
  to: string;
  /** Exact model anchor (ms) — lets delta seeding rebuild the identical
   * hour grid later. Absent on pre-delta holds (they full-rebuild). */
  anchorMs?: number;
  totalRequests: number;
  /** Exact per-day projections — the numbers Phase 6 asserts against the
   * dashboard. */
  projectedDaily: Array<{
    date: string;
    requests: number;
    http5xx: number;
    memoryTimeKbs: number;
    wallCpuMillis: number;
  }>;
}

interface BudgetVerdict {
  rawRows: number;
  budget: number;
  generated: number;
  ok: boolean;
  message: string | null;
}

function checkBudget(
  telemetry: TelemetryBlock,
  model: TrafficModel,
): BudgetVerdict {
  const budget = telemetry.rowBudget ?? DEFAULT_ROW_BUDGET;
  if (model.rawRequests > budget) {
    return {
      rawRows: model.rawRequests,
      budget,
      generated: model.totalRequests,
      ok: false,
      message:
        `telemetry projects ${model.rawRequests.toLocaleString()} raw ` +
        `request rows in the ${telemetry.rawWindow} raw window — over the ` +
        `row budget of ${budget.toLocaleString()}. Cut \`telemetry.rps.base\`, ` +
        "shrink `telemetry.rawWindow`, or raise `telemetry.rowBudget`.",
    };
  }
  if (model.totalRequests > GENERATION_CEILING) {
    return {
      rawRows: model.rawRequests,
      budget,
      generated: model.totalRequests,
      ok: false,
      message:
        `telemetry projects ${model.totalRequests.toLocaleString()} total ` +
        `generated requests — over the ${GENERATION_CEILING.toLocaleString()} ` +
        "generation ceiling. Cut `telemetry.rps.base` or `telemetry.history`.",
    };
  }
  return {
    rawRows: model.rawRequests,
    budget,
    generated: model.totalRequests,
    ok: true,
    message: null,
  };
}

function latencyMultiIf(telemetry: TelemetryBlock, u: string): string {
  const p50 = parseDurationMs(telemetry.latency.p50);
  const p95 = parseDurationMs(telemetry.latency.p95);
  const p99 = parseDurationMs(telemetry.latency.p99);
  return (
    `toUInt64(round(multiIf(${u} < 0.5, ${p50} * (0.4 + 1.2 * ${u}), ` +
    `${u} < 0.95, ${p50} + (${p95} - ${p50}) * (${u} - 0.5) / 0.45, ` +
    `${u} < 0.99, ${p95} + (${p99} - ${p95}) * (${u} - 0.95) / 0.04, ` +
    `${p99} * (1 + (${u} - 0.99) * 25))))`
  );
}

/** Deterministic v4-shaped UUID from two 64-bit hashes, server-side. */
function uuidExpr(seedExpr: string): string {
  // hex(UInt64) drops leading zeros, so pad each half back to 16 chars.
  const hex = `concat(leftPad(lower(hex(cityHash64('sim-uuid-a', ${seedExpr}))), 16, '0'), leftPad(lower(hex(cityHash64('sim-uuid-b', ${seedExpr}))), 16, '0'))`;
  return (
    `toUUID(concat(substring(${hex}, 1, 8), '-', substring(${hex}, 9, 4), ` +
    `'-', substring(${hex}, 13, 4), '-', substring(${hex}, 17, 4), '-', ` +
    `substring(${hex}, 21, 12)))`
  );
}

function workloadUuid(appPk: number): string {
  // Stable per-app workload id; recorded implicitly via the owner key.
  const hex = appPk.toString(16).padStart(12, "0");
  return `99999999-5150-4e0d-1000-${hex}`;
}

function tokenUuid(ownerPk: number): string {
  const hex = ownerPk.toString(16).padStart(12, "0");
  return `99999999-5150-4e0d-2000-${hex}`;
}

/** The 5xx stripe: a request's lane is its row index modulo 1000; lanes
 * below the hour's permille are 5xx. Exact by construction (see
 * serverSideErrorCount); 4xx/3xx come from hash lanes above the stripe. */
const CLASS_EXPR =
  "multiIf(lane < err, 3, h1 % 1000 < 15, 2, h1 % 1000 < 23, 1, 0)";

export interface AppTarget {
  appPk: number;
  versionPk: number;
  externalId: string;
  name: string;
  share: number;
}

export async function insertAggregateHours(
  clickhouse: SimulatorClickHouse,
  telemetry: TelemetryBlock,
  model: Pick<TrafficModel, "hours">,
  app: AppTarget,
  appIndex: number,
  ownerPk: number,
  seed: number,
  rrOffsets?: number[],
): Promise<void> {
  const aggregateIndexes = model.hours
    .map((hour, index) => ({ hour, index }))
    .filter(({ hour }) => !hour.raw);
  if (aggregateIndexes.length === 0) {
    return;
  }
  // Chunk so statements stay bounded AND run concurrently: ClickHouse
  // executes one INSERT..SELECT mostly single-threaded, so 4 in flight
  // roughly quarters the dominant generation cost.
  const CHUNK = 600;
  const statements: string[] = [];
  for (let offset = 0; offset < aggregateIndexes.length; offset += CHUNK) {
    const chunk = aggregateIndexes.slice(offset, offset + CHUNK);
    const counts = chunk.map(({ hour }) => hour.perApp[appIndex]);
    if (counts.every((count) => count === 0)) {
      continue;
    }
    const starts = chunk.map(({ hour }) => hour.start);
    const errs = chunk.map(({ hour }) => hour.errPermille);
    const offs = chunk.map(({ index }) => rrOffsets?.[index] ?? 0);
    const base = starts[0];
    const startsExpr = `[${starts.map((start) => start - base).join(",")}]`;
    const countsExpr = `[${counts.join(",")}]`;
    const errsExpr = `[${errs.join(",")}]`;
    const offsExpr = `[${offs.join(",")}]`;
    const rowSeed = `toString(${seed}), toString(hh), toString(rr)`;
    const sql = `
INSERT INTO ${clickhouse.database}.request_log_hourly_by_owner_app
  (app_owner_id, app_owner_is_user, app_id, grouped_at_hour,
   http_total_count, cached_count, http_2xx_count, http_3xx_count,
   http_4xx_count, http_5xx_count, http_other_count,
   http_total_duration_millis, unique_users_ipv6, total_data_served_bytes,
   total_data_cached_bytes, total_data_received_bytes, edge_outcome_success)
SELECT
  ${ownerPk}, 0, ${app.appPk}, toDateTime(${base} + hourOffset),
  countState(),
  sumState(toUInt64(0)),
  sumState(toUInt64(cls = 0)),
  sumState(toUInt64(cls = 1)),
  sumState(toUInt64(cls = 2)),
  sumState(toUInt64(cls = 3)),
  sumState(toUInt64(0)),
  sumState(${latencyMultiIf(telemetry, "u2")}),
  uniqCombined64State(cityHash64('sim-uid', toString(${seed}), toString(hh), toString(intDiv(rr, 7)))),
  sumState(toUInt64(800 + h1 % 4000)),
  sumState(toUInt64(0)),
  sumState(toUInt64(120 + h2 % 300)),
  sumState(toUInt8(cls != 3))
FROM (
  SELECT hh, rr, hourOffset, lane, err, h1, h2,
    (h2 % 10000) / 10000 AS u2,
    ${CLASS_EXPR} AS cls
  FROM (
    SELECT hh, rr,
      ${startsExpr}[hh + 1] AS hourOffset,
      rr % 1000 AS lane,
      ${errsExpr}[hh + 1] AS err,
      cityHash64('sim-a', ${rowSeed}) AS h1,
      cityHash64('sim-b', ${rowSeed}) AS h2
    FROM (
      SELECT hh, rr0 + ${offsExpr}[hh + 1] AS rr
      FROM (
        SELECT number AS hh, ${countsExpr}[number + 1] AS c
        FROM numbers(${chunk.length})
      ) ARRAY JOIN range(assumeNotNull(toUInt64(c))) AS rr0
    )
  )
)
GROUP BY hourOffset`;
    statements.push(sql);
  }
  await runConcurrently(statements, (sql) => clickhouse.query(sql, 300_000));
}

/** Bounded-concurrency runner for independent statements. */
async function runConcurrently<T>(
  items: T[],
  run: (item: T) => Promise<unknown>,
  width = 4,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      await run(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, () => worker()),
  );
}

export async function insertRawHours(
  clickhouse: SimulatorClickHouse,
  telemetry: TelemetryBlock,
  model: Pick<TrafficModel, "hours">,
  app: AppTarget,
  appIndex: number,
  ownerPk: number,
  seed: number,
  appDomain: string,
  rrOffsets?: number[],
): Promise<void> {
  const allRawIndexes = model.hours
    .map((hour, index) => ({ hour, index }))
    .filter(({ hour }) => hour.raw);
  if (allRawIndexes.length === 0) {
    return;
  }
  // Split into concurrent statement groups (same rationale as the
  // aggregate writer: one INSERT..SELECT is mostly single-threaded).
  const GROUPS = 4;
  const groupSize = Math.ceil(allRawIndexes.length / GROUPS);
  const statements: string[] = [];
  for (let at = 0; at < allRawIndexes.length; at += groupSize) {
    const rawIndexes = allRawIndexes.slice(at, at + groupSize);
    const counts = rawIndexes.map(({ hour }) => hour.perApp[appIndex]);
    const starts = rawIndexes.map(({ hour }) => hour.start);
    const errs = rawIndexes.map(({ hour }) => hour.errPermille);
    const offs = rawIndexes.map(({ index }) => rrOffsets?.[index] ?? 0);
    const base = starts[0];
    const startsExpr = `[${starts.map((start) => start - base).join(",")}]`;
    const countsExpr = `[${counts.join(",")}]`;
    const errsExpr = `[${errs.join(",")}]`;
    const offsExpr = `[${offs.join(",")}]`;
    const rowSeed = `toString(${seed}), toString(hh), toString(rr)`;
    const paths =
      "['/', '/api/health', '/api/items', '/assets/app.js', '/favicon.ico', '/about']";
    const sql = `
INSERT INTO ${clickhouse.database}.request_log
  (node_id, node_global_ipv4, workload_id, request_id, external_id,
   received_at, total_duration_microseconds, client_ipv4, http_version,
   http_method, request_domain, url_path, outcome, response_http_status,
   request_body_size, response_from_cache, response_body_size, app_id,
   app_version_id, app_owner_id, app_owner_is_user, protocol)
SELECT
  toUUID('${SIM_NODE_UUID}'),
  toIPv4('127.0.0.1'),
  toUUID('${workloadUuid(app.appPk)}'),
  ${uuidExpr(`concat(${rowSeed})`)},
  '${app.externalId}',
  toDateTime64(${base} + hourOffset + (rr0 * 3600.0) / greatest(c, 1), 3),
  ${latencyMultiIf(telemetry, "u2")} * 1000,
  toIPv4(toUInt32(167772160 + h1 % 1048576)),
  'HTTP/1.1',
  if(h2 % 100 < 92, 'GET', if(h2 % 100 < 98, 'POST', 'PUT')),
  '${app.name}.${appDomain}',
  ${paths}[1 + h1 % 6],
  if(cls = 3, 'error', 'success'),
  multiIf(cls = 3, toUInt16(500 + h1 % 4), cls = 2, toUInt16(if(h2 % 3 = 0, 404, 400)), cls = 1, toUInt16(301), toUInt16(200)),
  toUInt64(if(h2 % 100 < 92, 0, 200 + h1 % 2000)),
  false,
  toUInt64(800 + h1 % 4000),
  ${app.appPk}, ${app.versionPk}, ${ownerPk}, false, 'https'
FROM (
  SELECT hh, rr, rr0, hourOffset, c, h1, h2,
    (h2 % 10000) / 10000 AS u2,
    rr % 1000 AS lane,
    ${errsExpr}[hh + 1] AS err,
    ${CLASS_EXPR} AS cls
  FROM (
    SELECT hh, rr, rr0, hourOffset, c,
      cityHash64('sim-a', ${rowSeed}) AS h1,
      cityHash64('sim-b', ${rowSeed}) AS h2
    FROM (
      SELECT hh, rr0, rr0 + ${offsExpr}[hh + 1] AS rr, hourOffset, c
      FROM (
        SELECT number AS hh,
          ${startsExpr}[number + 1] AS hourOffset,
          ${countsExpr}[number + 1] AS c
        FROM numbers(${rawIndexes.length})
      ) ARRAY JOIN range(assumeNotNull(toUInt64(c))) AS rr0
    )
  )
)`;
    statements.push(sql);
  }
  await runConcurrently(statements, (sql) => clickhouse.query(sql, 600_000));
}

/** The hourly rollup groups by `toStartOfHour(completed_at)`, so an hour's
 * summary must complete *inside* its own hour - `+3600` would attribute it
 * to the next one, which OBSERVE then reads as a shortfall. */
export async function insertWorkloadSummaries(
  clickhouse: SimulatorClickHouse,
  model: Pick<TrafficModel, "workloadHours">,
  app: AppTarget,
  appIndex: number,
  ownerPk: number,
): Promise<void> {
  const CHUNK = 2400;
  for (let offset = 0; offset < model.workloadHours.length; offset += CHUNK) {
    const chunk = model.workloadHours.slice(offset, offset + CHUNK);
    const base = chunk[0].start;
    const starts = chunk.map((hour) => hour.start - base);
    const cpu = chunk.map((hour) => hour.perApp[appIndex].cpuMillis);
    const mem = chunk.map((hour) => hour.perApp[appIndex].memoryTimeKbs);
    const ingress = chunk.map((hour) => hour.perApp[appIndex].ingressKb);
    const egress = chunk.map((hour) => hour.perApp[appIndex].egressKb);
    const sql = `
INSERT INTO ${clickhouse.database}.workload_metrics_summary
  (node_id, node_global_ipv4, workload_id, workload_type, token_id, agent,
   external_id, created_at, started_at, completed_at, network_ingress_kb,
   network_egress_kb, memory_time_kbs, cpu_time_millis, status, engine,
   real_cpu_time_millis, app_id, app_version_id, app_owner_id,
   app_owner_is_user, recorded_at)
SELECT
  toUUID('${SIM_NODE_UUID}'),
  toIPv4('127.0.0.1'),
  toUUID('${workloadUuid(app.appPk)}'),
  'app',
  toUUID('${tokenUuid(ownerPk)}'),
  'sim',
  '${app.externalId}',
  ts, ts, ts + 3599,
  toUInt64([${ingress.join(",")}][number + 1]),
  toUInt64([${egress.join(",")}][number + 1]),
  toUInt64([${mem.join(",")}][number + 1]),
  toUInt64([${cpu.join(",")}][number + 1]),
  'finished',
  'wasmer-cranelift',
  toUInt64(round([${cpu.join(",")}][number + 1] * 1.18)),
  ${app.appPk}, ${app.versionPk}, ${ownerPk}, false,
  ts + 3599
FROM (
  SELECT number, toDateTime64(${base} + [${starts.join(",")}][number + 1], 3) AS ts
  FROM numbers(${chunk.length})
)`;
    await clickhouse.query(sql, 300_000);
  }
}

async function insertSnapshots(
  clickhouse: SimulatorClickHouse,
  model: TrafficModel,
  app: AppTarget,
  appIndex: number,
  ownerPk: number,
): Promise<void> {
  const rawHours = model.workloadHours.filter(
    (_, index) => model.hours[index].raw,
  );
  if (rawHours.length === 0) {
    return;
  }
  const rows: string[] = [];
  for (const hour of rawHours) {
    const perApp = hour.perApp[appIndex];
    for (let sample = 0; sample < 6; sample++) {
      rows.push(
        JSON.stringify({
          node_id: SIM_NODE_UUID,
          node_global_ipv4: "127.0.0.1",
          workload_id: workloadUuid(app.appPk),
          workload_type: "app",
          token_id: tokenUuid(ownerPk),
          agent: "sim",
          external_id: app.externalId,
          recorded_at: formatDateTime(hour.start + sample * 600),
          workload_created_at: formatDateTime(hour.start),
          network_ingress_gauge_bytes: perApp.ingressKb * 1024,
          network_egress_gauge_bytes: perApp.egressKb * 1024,
          cpu_time_gauge_millis: Math.round(
            (perApp.cpuMillis * (sample + 1)) / 6,
          ),
          memory_usage_gauge_bytes: Math.round(
            (perApp.memoryTimeKbs / 3600) * 1024,
          ),
          real_cpu_time_gauge_millis: Math.round(
            (perApp.cpuMillis * 1.18 * (sample + 1)) / 6,
          ),
          app_id: app.appPk,
          app_version_id: app.versionPk,
          app_owner_id: ownerPk,
          app_owner_is_user: false,
        }),
      );
    }
  }
  await clickhouse.query(
    `INSERT INTO ${clickhouse.database}.workload_metrics_snapshot FORMAT JSONEachRow\n` +
      rows.join("\n"),
    300_000,
  );
}

function formatDateTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");
}

export const telemetrySeeder: Seeder = {
  block: "telemetry",

  plan(declaration: SimulatorDeclaration, planCtx): string[] {
    const telemetry = declaration.telemetry;
    if (telemetry === undefined) {
      return [];
    }
    const appCount = declaration.apps?.count ?? 1;
    // Same fork label the apps seeder uses, so the name list matches.
    const names = appNames(planCtx.random.fork("fabricated-names"), appCount);
    let multipliers: number[] | undefined;
    try {
      multipliers = resolvePerAppMultipliers(telemetry.rps.perApp, names);
    } catch (error) {
      throw new SeedPlanError((error as Error).message);
    }
    const model = expandTraffic(
      telemetry,
      planCtx.seed,
      appCount,
      Date.now(),
      multipliers,
    );
    const verdict = checkBudget(telemetry, model);
    if (!verdict.ok) {
      throw new SeedPlanError(verdict.message ?? "over budget");
    }
    const surgeLines =
      multipliers === undefined
        ? []
        : [
            "  per-app traffic: " +
              Object.entries(telemetry.rps.perApp)
                .map(([name, factor]) => `${name} ×${factor}`)
                .join(", "),
          ];
    const days = model.daily.length;
    return [
      `telemetry: ${telemetry.history} history (${days} days) across ` +
        `${appCount} apps`,
      ...surgeLines,
      `  total requests: ${model.totalRequests.toLocaleString()} — ` +
        `${model.rawRequests.toLocaleString()} raw rows in the last ` +
        `${telemetry.rawWindow} (budget ${verdict.budget.toLocaleString()}), ` +
        "the rest exact hourly aggregates",
      `  first day ${model.daily[0]?.date}: ` +
        `${model.daily[0]?.requests.toLocaleString()} requests; last day ` +
        `${model.daily[days - 1]?.date}: ` +
        `${model.daily[days - 1]?.requests.toLocaleString()}`,
      `  workload rows: ${(model.workloadHours.length * appCount).toLocaleString()} ` +
        "summaries (hourly, full history)",
    ];
  },

  async apply(
    declaration: SimulatorDeclaration,
    ctx: SeedContext,
    emit: EmitEntry,
  ): Promise<void> {
    const telemetry = declaration.telemetry;
    if (telemetry === undefined) {
      return;
    }
    const ownerPk = ctx.ids.namespacePk;
    if (ownerPk === undefined || ctx.ids.apps.length === 0) {
      throw new Error(
        "telemetry seeder needs the account and at least one app (§3.1 " +
          "order); declare an `apps` block alongside `telemetry`",
      );
    }
    const clickhouse = new SimulatorClickHouse(ctx.env);
    for (const [table, columns] of Object.entries(TELEMETRY_TABLES)) {
      await clickhouse.assertColumns(table, columns);
    }

    let multipliers: number[] | undefined;
    try {
      multipliers = resolvePerAppMultipliers(
        telemetry.rps.perApp,
        ctx.ids.apps.map((app) => app.name),
      );
    } catch (error) {
      throw new SeedPlanError((error as Error).message);
    }
    const anchorMs = Date.now();
    const model = expandTraffic(
      telemetry,
      ctx.seed,
      ctx.ids.apps.length,
      anchorMs,
      multipliers,
    );
    const verdict = checkBudget(telemetry, model);
    if (!verdict.ok) {
      throw new SeedPlanError(verdict.message ?? "over budget");
    }

    const apps: AppTarget[] = ctx.ids.apps.map((app, index) => ({
      appPk: app.appPk,
      versionPk: app.versionPk ?? app.appPk,
      externalId: app.appId,
      name: app.name,
      share: model.perApp[index].weight,
    }));

    // Emitted before the first insert: the owner key covers every row that
    // lands afterwards, so a crash mid-insert is fully cleanable.
    emit({
      kind: "clickhouse-rows",
      ownerId: ownerPk,
      appExternalIds: apps.map((app) => app.externalId),
      from: new Date(model.hours[0].start * 1000).toISOString(),
      to: new Date(
        (model.hours[model.hours.length - 1].start + 3600) * 1000,
      ).toISOString(),
      anchorMs,
      totalRequests: model.totalRequests,
      projectedDaily: model.daily,
    } satisfies ClickHouseRowsEntry);

    const started = Date.now();
    ctx.io.err(
      `telemetry: writing ${model.totalRequests.toLocaleString()} requests ` +
        `(${model.rawRequests.toLocaleString()} raw) + ` +
        `${(model.workloadHours.length * apps.length).toLocaleString()} workload ` +
        `summaries for ${apps.length} apps…`,
    );
    const appDomain = ctx.env["WASMER_APP_DOMAIN"] ?? "localhost";
    // Per-app writes are independent (distinct app_id keys), so a worker
    // pool cuts the dominant reseed cost roughly by the pool width
    // (trial-2 option A). ClickHouse handles the concurrent inserts; the
    // usage-snapshot Postgres writes stay after the pool.
    const WRITE_CONCURRENCY = 4;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= apps.length) {
          return;
        }
        const app = apps[index];
        await insertAggregateHours(
          clickhouse,
          telemetry,
          model,
          app,
          index,
          ownerPk,
          ctx.seed,
        );
        await insertRawHours(
          clickhouse,
          telemetry,
          model,
          app,
          index,
          ownerPk,
          ctx.seed,
          appDomain,
        );
        await insertWorkloadSummaries(clickhouse, model, app, index, ownerPk);
        await insertSnapshots(clickhouse, model, app, index, ownerPk);
        if (ctx.verbose) {
          ctx.io.err(`telemetry: ${app.name} done`);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(WRITE_CONCURRENCY, apps.length) }, () =>
        worker(),
      ),
    );
    const seconds = (Date.now() - started) / 1000;
    ctx.io.err(
      `telemetry: inserted in ${seconds.toFixed(1)}s ` +
        `(${Math.round(model.totalRequests / Math.max(seconds, 0.1)).toLocaleString()} requests/s effective)`,
    );

    await writeUsageSnapshots(ctx, model, emit);

    const totalMemoryKbs = model.daily.reduce(
      (sum, day) => sum + day.memoryTimeKbs,
      0,
    );
    ctx.ids.telemetryTotals = {
      memoryGbh: totalMemoryKbs / (1024 * 1024) / 3600,
      wallCpuMillis: model.daily.reduce(
        (sum, day) => sum + day.wallCpuMillis,
        0,
      ),
      requests: model.totalRequests,
      daily: model.daily.map((day) => ({
        date: day.date,
        memoryGbh: day.memoryTimeKbs / (1024 * 1024) / 3600,
      })),
    };
  },
};

/** Hourly usage-snapshot rows for the whole history: what the usage page's
 * `used` figures sum over the billing window (verified against the live
 * resolver: `aggregate_owner_usage_in_window`, resolution `hour`). */
async function writeUsageSnapshots(
  ctx: SeedContext,
  model: TrafficModel,
  emit: EmitEntry,
): Promise<void> {
  const postgres = await connectSimulatorPostgres(ctx.env);
  try {
    await assertTableColumns(
      postgres,
      USAGE_SNAPSHOT_TABLE,
      USAGE_SNAPSHOT_COLUMNS,
    );
    const contentType = await postgres.query<{ id: number }>(
      `SELECT id FROM django_content_type
       WHERE app_label = 'registry' AND model = 'namespace'`,
    );
    if (contentType.rows.length !== 1) {
      throw new Error("cannot resolve the registry.namespace content type");
    }
    const pks: number[] = [];
    const CHUNK = 400;
    for (let offset = 0; offset < model.hours.length; offset += CHUNK) {
      const chunk = model.hours.slice(offset, offset + CHUNK);
      const values: string[] = [];
      const params: unknown[] = [];
      chunk.forEach((hour, index) => {
        const perApp = model.workloadHours[offset + index].perApp;
        const cpuMillis = perApp.reduce((sum, app) => sum + app.cpuMillis, 0);
        const memKbs = perApp.reduce((sum, app) => sum + app.memoryTimeKbs, 0);
        const ingressKb = perApp.reduce((sum, app) => sum + app.ingressKb, 0);
        const egressKb = perApp.reduce((sum, app) => sum + app.egressKb, 0);
        const base = params.length;
        values.push(
          `(NOW(), $${base + 1}, $${base + 2}, 'hour', $${base + 3}, $${base + 4},
            $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9},
            0, 0, 0, 0, 0, 0, 0, 0, 'manual')`,
        );
        params.push(
          new Date(hour.start * 1000),
          new Date((hour.start + 3600) * 1000),
          contentType.rows[0].id,
          ctx.ids.namespacePk,
          hour.count,
          ingressKb * 1024,
          egressKb * 1024,
          cpuMillis / 3_600_000,
          memKbs / (1024 * 1024) / 3600,
        );
      });
      const inserted = await postgres.query<{ id: number }>(
        `INSERT INTO ${USAGE_SNAPSHOT_TABLE}
           (created_at, snapshot_started_at, snapshot_ended_at, resolution,
            owner_content_type_id, owner_object_id, no_requests,
            network_ingress_bytes, network_egress_bytes, cpu_time_hours,
            memory_time_gbh, app_count, domain_count, build_minutes,
            volume_storage_bytes, package_storage_bytes, db_storage_bytes,
            member_count, email_sent, source)
         VALUES ${values.join(",")}
         RETURNING id`,
        params,
      );
      pks.push(...inserted.rows.map((row) => row.id));
    }
    emit({ kind: "postgres-rows", table: USAGE_SNAPSHOT_TABLE, pks });
    ctx.io.err(
      `telemetry: ${pks.length} hourly usage snapshots written (usage page)`,
    );
  } finally {
    await postgres.end().catch(() => undefined);
  }
}

export { serverSideErrorCount };
