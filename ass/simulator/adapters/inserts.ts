// Server-side ClickHouse insert generators shared by the telemetry
// adapters (read-path facts verified live 2026-08-14): exact aggregate
// states into request_log_hourly_by_owner_app, raw request rows inside the
// precision window, and hourly workload summaries. Counts are decided
// client-side by the traffic model, so the plan, the database, and the
// asserted surface share one set of numbers.

import { SimulatorClickHouse } from "../clients/clickhouse";
import { parseDurationMs } from "../scenario";
import type { TrafficModel } from "../traffic";

/** Raw-level ownership is this node id. */
export const SIM_NODE_UUID = "99999999-5150-4e0d-0000-000000000001";

/** The slice of the telemetry block the SQL generators read. */
export interface LatencyShape {
  latency: { p50: string; p95: string; p99: string };
}

function latencyMultiIf(telemetry: LatencyShape, u: string): string {
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
  telemetry: LatencyShape,
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
  telemetry: LatencyShape,
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
