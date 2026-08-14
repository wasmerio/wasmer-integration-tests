// Request telemetry: day digests (level 1), hourly buckets (level 2) and
// literal requests.
//
// Bucket diffing is additive and one-sided (section 7.3, normative). A
// declaration states a floor; organic traffic can only push a bucket up,
// and up is never actionable - which is what lets a developer click around
// a seeded app without producing a plan. The two intents that authorize a
// downward write are a declared change (this bucket's day fingerprint
// differs from the one the previous reconcile recorded) and `--exact`.

import { digestFingerprint } from "../digest";
import {
  defaultDiff,
  type DiffContext,
  type ResourceAdapter,
  type Scope,
} from "../adapter";
import {
  fingerprint,
  id,
  type Digest,
  type OpResult,
  type Operation,
  type Resource,
} from "../model";
import type { DayDigestSpec, RequestBucketSpec, RequestSpec } from "../specs";
import { mapConcurrent, type EngineContext } from "../engine/context";
import {
  insertAggregateHours,
  insertRawHours,
  SIM_NODE_UUID,
  type AppTarget,
} from "./inserts";
import { clearBuckets, rebuildCoarserLevels, type HourSet } from "./rollups";
import { failed, ok } from "./common";

const HOUR_SEC = 3600;

/** Literal rows carry this workload id and nothing else does, so a declared
 * request is observable without scanning the raw table by content. */
export const SIM_LITERAL_WORKLOAD = "99999999-5150-4e0d-3000-000000000001";

export function ownerPkOf(ctx: EngineContext, scope: Scope): number | null {
  const namespaceId = id("namespace", scope.namespace);
  return ctx.identity.has(namespaceId)
    ? ctx.identity.requireNumber(namespaceId, "pk")
    : null;
}

export function parseDigestRows(
  body: string,
  ctx: EngineContext,
  scope: Scope,
  kind: "request-day" | "workload-day",
  sumNames: string[],
): Digest[] {
  const digests: Digest[] = [];
  for (const line of body.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const columns = line.split("\t");
    const appId = ctx.identity.byNative("app", "pk", Number(columns[0]));
    if (appId === undefined) {
      continue;
    }
    const epochDay = Number(columns[1]);
    const members = Number(columns[2]);
    const sums: Record<string, number> = {};
    sumNames.forEach((name, index) => {
      sums[name] = Number(columns[3 + index]);
    });
    const weighted = Number(columns[3 + sumNames.length]);
    digests.push({
      id: id(
        kind,
        scope.namespace,
        appId.segments[1],
        String(epochDay).padStart(7, "0"),
      ),
      fingerprint: digestFingerprint({ members, sums, weighted }),
      members,
    });
  }
  return digests;
}

/** Level-2 predicate: only the days level 1 flagged, as hour ranges so
 * ClickHouse prunes by primary key. */
export function drillPredicate(scope: Scope, column: string): string | null {
  if (scope.drill === undefined) {
    return `${column} >= toDateTime(${scope.fromSec}) AND ${column} < toDateTime(${scope.toSec})`;
  }
  if (scope.drill.size === 0) {
    return null;
  }
  const days = [
    ...new Set([...scope.drill].map((entry) => Number(entry.split("/")[1]))),
  ].sort((a, b) => a - b);
  return `(${days
    .map(
      (day) =>
        `(${column} >= toDateTime(${day * 86400}) AND ${column} < toDateTime(${(day + 1) * 86400}))`,
    )
    .join(" OR ")})`;
}

export const requestDayAdapter: ResourceAdapter<DayDigestSpec> = {
  kind: "request-day",
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
    // Epoch arithmetic throughout: no server timezone can move a day
    // boundary out from under the declaration half.
    const body = await ctx.clickhouse.query(
      `SELECT app_id,
              intDiv(toUnixTimestamp(grouped_at_hour), 86400) AS d,
              count() AS members,
              sum(total_requests) AS requests,
              sum(http_5xx) AS http5xx,
              sum(total_requests * (intDiv(toUnixTimestamp(grouped_at_hour) % 86400, 3600) + 1)) AS weighted
         FROM ${ctx.clickhouse.database}.request_log_hourly_by_owner_app_final
        WHERE app_owner_id = ${ownerPk} AND app_owner_is_user = 0
          AND grouped_at_hour >= toDateTime(${scope.fromSec})
          AND grouped_at_hour < toDateTime(${scope.toSec})
        GROUP BY app_id, d FORMAT TSV`,
    );
    return parseDigestRows(body, ctx, scope, "request-day", [
      "requests",
      "http5xx",
    ]);
  },

  diff() {
    return [];
  },

  async apply(): Promise<OpResult[]> {
    return [];
  },
};

export const requestBucketAdapter: ResourceAdapter<RequestBucketSpec> = {
  kind: "request-bucket",
  lane: "clickhouse",
  granularity: "bucket",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<RequestBucketSpec>[]> {
    const ownerPk = ownerPkOf(ctx, scope);
    const predicate = drillPredicate(scope, "grouped_at_hour");
    if (ownerPk === null || predicate === null) {
      return [];
    }
    const body = await ctx.clickhouse.query(
      `SELECT app_id, toUnixTimestamp(grouped_at_hour), total_requests, http_5xx
         FROM ${ctx.clickhouse.database}.request_log_hourly_by_owner_app_final
        WHERE app_owner_id = ${ownerPk} AND app_owner_is_user = 0 AND ${predicate}
        FORMAT TSV`,
    );
    const observed: Array<Resource<RequestBucketSpec>> = [];
    for (const line of body.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const [appPk, ts, requests, http5xx] = line.split("\t");
      const appId = ctx.identity.byNative("app", "pk", Number(appPk));
      if (appId === undefined) {
        continue;
      }
      const epochHour = Math.floor(Number(ts) / HOUR_SEC);
      observed.push({
        id: id(
          "request-bucket",
          scope.namespace,
          appId.segments[1],
          String(epochHour).padStart(9, "0"),
        ),
        kind: "request-bucket",
        spec: {
          namespace: scope.namespace,
          app: appId.segments[1],
          epochHour,
          mode: "aggregate",
          requests: Number(requests),
          http5xx: Number(http5xx),
          errPermille: 0,
          latency: { p50: "", p95: "", p99: "" },
          literals: 0,
          seed: 0,
        },
        // Observed buckets carry no fingerprint: the rollups report neither
        // latency nor seed, so the bucket diff is numeric by construction.
        fingerprint: "",
        deps: [],
        policy: { prune: "delete", precision: "aggregate" },
      });
    }
    observed.sort((a, b) =>
      a.id.segments.join("/") < b.id.segments.join("/") ? -1 : 1,
    );
    return observed;
  },

  diff(desired, observed, ctx) {
    return diffBucket(desired, observed, ctx, (spec) => spec.requests);
  },

  async apply(
    ops: Operation<RequestBucketSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    return applyRequestBuckets(ops, ctx);
  },
};

/** The additive bucket rule (section 7.3), shared with workload buckets. */
export function diffBucket<S extends { app: string; epochHour: number }>(
  desired: Resource<S> | null,
  observed: Resource<S> | null,
  ctx: DiffContext,
  amountOf: (spec: S) => number,
): Operation[] {
  const lane = "clickhouse" as const;
  if (desired === null && observed === null) {
    return [];
  }
  if (desired === null && observed !== null) {
    // Undeclared state. Additive semantics leave it alone; `--exact` (CI)
    // and teardown (which reconciles to the empty set) remove it.
    return ctx.exact
      ? [
          {
            type: "delete",
            id: observed.id,
            kind: observed.kind,
            lane,
            desired: null,
            observed,
          },
        ]
      : [];
  }
  if (desired !== null && observed === null) {
    return [
      {
        type: "create",
        id: desired.id,
        kind: desired.kind,
        lane,
        desired,
        observed: null,
      },
    ];
  }
  const transition = modeTransition(desired as Resource<S>, ctx);
  if (transition !== null) {
    return [
      {
        type: transition,
        id: (desired as Resource<S>).id,
        kind: (desired as Resource<S>).kind,
        lane,
        desired,
        observed,
      },
    ];
  }
  const want = amountOf((desired as Resource<S>).spec);
  const have = amountOf((observed as Resource<S>).spec);
  if (have < want) {
    // The shortfall is written as a continuation of the same lane stripe,
    // starting at the recorded offset - the proven rr-offset technique, so
    // the 5xx count stays exact after the patch.
    return [
      {
        type: "patch",
        id: (desired as Resource<S>).id,
        kind: (desired as Resource<S>).kind,
        lane,
        desired,
        observed,
        detail: { delta: want - have, offset: have },
      },
    ];
  }
  if (have > want) {
    ctx.reportSurplus({
      id: (desired as Resource<S>).id,
      desired: want,
      observed: have,
    });
    if (ctx.exact || declaredChange(desired as Resource<S>, ctx)) {
      return [
        {
          type: "replace",
          id: (desired as Resource<S>).id,
          kind: (desired as Resource<S>).kind,
          lane,
          desired,
          observed,
        },
      ];
    }
  }
  return [];
}

/** P3: a mode change is an explicit `demote`/`promote`, never an overwrite.
 *
 * Sliding forward - the common case, one reconcile per day of drift - only
 * demotes: the hour left the raw window, its raw rows go, and the states
 * they already produced are what the aggregate writer would have written
 * (P2), so nothing is rewritten. Sliding backward promotes, which does cost
 * a rewrite, and the plan says so rather than doing it quietly. */
function modeTransition<S>(
  desired: Resource<S>,
  ctx: DiffContext,
): "promote" | "demote" | null {
  const spec = desired.spec as {
    mode?: "aggregate" | "raw";
    app?: string;
    epochHour?: number;
  };
  if (
    spec.mode === undefined ||
    spec.app === undefined ||
    spec.epochHour === undefined
  ) {
    return null;
  }
  const previousRawFrom = ctx.previousRawFrom.get(spec.app);
  if (previousRawFrom === undefined) {
    return null;
  }
  const previousMode =
    spec.epochHour * 3600 >= previousRawFrom ? "raw" : "aggregate";
  if (previousMode === spec.mode) {
    return null;
  }
  return spec.mode === "raw" ? "promote" : "demote";
}

/** The ledger is consulted for *intent*: did the human change what this
 * day declares since the last reconcile? Never for evidence of state. */
function declaredChange<S>(desired: Resource<S>, ctx: DiffContext): boolean {
  const dayKey = `${desired.kind === "workload-bucket" ? "workload-day" : "request-day"}:${
    desired.id.segments[0]
  }/${desired.id.segments[1]}/${String(Math.floor(Number(desired.id.segments[2]) / 24)).padStart(7, "0")}`;
  const previous = ctx.previousDigests.get(dayKey);
  const current = ctx.desiredDigests.get(dayKey);
  return (
    previous !== undefined && current !== undefined && previous !== current
  );
}

interface BucketWrite {
  app: string;
  epochHour: number;
  count: number;
  errPermille: number;
  offset: number;
  mode: "aggregate" | "raw";
}

async function applyRequestBuckets(
  ops: Operation<RequestBucketSpec>[],
  ctx: EngineContext,
): Promise<OpResult[]> {
  const stats: Record<string, number> = {};
  const first = ops.find((operation) => operation.desired !== null)?.desired
    ?.spec;
  const namespace = (first ?? ops[0].observed?.spec)?.namespace ?? "";
  const ownerPk = ctx.identity.requireNumber(id("namespace", namespace), "pk");

  const clears: Operation<RequestBucketSpec>[] = [];
  const demotes: Operation<RequestBucketSpec>[] = [];
  const writes: BucketWrite[] = [];

  for (const operation of ops) {
    if (operation.type === "demote") {
      demotes.push(operation);
      continue;
    }
    if (
      operation.type === "delete" ||
      operation.type === "replace" ||
      operation.type === "promote"
    ) {
      clears.push(operation);
    }
    const desired = operation.desired?.spec;
    if (desired === undefined || operation.type === "delete") {
      continue;
    }
    const isPatch = operation.type === "patch";
    // P1: the literals are part of this bucket's desired count, and the
    // literal adapter writes them as exact rows - so the generator supplies
    // only the remainder.
    const count = isPatch
      ? Number(operation.detail?.["delta"] ?? 0)
      : Math.max(0, desired.requests - desired.literals);
    if (count <= 0) {
      continue;
    }
    writes.push({
      app: desired.app,
      epochHour: desired.epochHour,
      count,
      errPermille: desired.errPermille,
      offset: isPatch ? Number(operation.detail?.["offset"] ?? 0) : 0,
      mode: desired.mode,
    });
  }

  try {
    // P3 demote: the hour left the raw window. Its raw rows go; the states
    // they already produced are exactly what the aggregate writer would
    // have written (P2), so nothing is rebuilt and nothing is awaited.
    if (demotes.length > 0) {
      await clearBuckets(
        ctx,
        {
          family: "request",
          ownerPk,
          sets: hourSets(demotes, ctx, namespace),
          externalIds: externalIdsOf(demotes, ctx, namespace),
          includeRaw: true,
          rawOnly: true,
        },
        stats,
      );
    }
    if (clears.length > 0) {
      await clearBuckets(
        ctx,
        {
          family: "request",
          ownerPk,
          sets: hourSets(clears, ctx, namespace),
          externalIds: externalIdsOf(clears, ctx, namespace),
          // A delete removes the bucket at every level it exists, and an
          // observed bucket never reports its own precision (no rollup
          // carries it) - so a teardown always takes the raw rows with it.
          // A promote (aggregate -> raw) must additionally drop the
          // aggregate states before the raw rows rebuild them, or the hour
          // counts twice.
          includeRaw: clears.some(
            (operation) =>
              operation.type === "delete" ||
              operation.desired?.spec.mode === "raw" ||
              operation.observed?.spec.mode === "raw",
          ),
        },
        stats,
      );
    }
  } catch (err) {
    return ops.map((operation) => failed(operation.id, err));
  }

  if (writes.length > 0) {
    const latency = first?.latency ?? {
      p50: "45ms",
      p95: "300ms",
      p99: "900ms",
    };
    const seed = first?.seed ?? 0;
    const perApp = new Map<string, BucketWrite[]>();
    for (const write of writes) {
      const list = perApp.get(write.app) ?? [];
      list.push(write);
      perApp.set(write.app, list);
    }
    const outcomes = await mapConcurrent(
      [...perApp.entries()],
      ctx.workers.clickhouse,
      async ([app, appWrites]) => {
        try {
          const target = appTarget(ctx, namespace, app);
          const sorted = [...appWrites].sort(
            (a, b) => a.epochHour - b.epochHour,
          );
          const aggregate = sorted.filter(
            (write) => write.mode === "aggregate",
          );
          const raw = sorted.filter((write) => write.mode === "raw");
          const telemetryShape = { latency };
          await Promise.all([
            aggregate.length === 0
              ? Promise.resolve()
              : insertAggregateHours(
                  ctx.clickhouse,
                  telemetryShape,
                  { hours: syntheticHours(aggregate, false) },
                  target,
                  0,
                  ownerPk,
                  seed,
                  aggregate.map((write) => write.offset),
                ),
            raw.length === 0
              ? Promise.resolve()
              : insertRawHours(
                  ctx.clickhouse,
                  telemetryShape,
                  { hours: syntheticHours(raw, true) },
                  target,
                  0,
                  ownerPk,
                  seed,
                  ctx.env["WASMER_APP_DOMAIN"] ?? "localhost",
                  raw.map((write) => write.offset),
                ),
          ]);
          return {
            app,
            rows: sorted.reduce((sum, write) => sum + write.count, 0),
            error: null as string | null,
          };
        } catch (err) {
          return {
            app,
            rows: 0,
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
    stats["requestRows"] = outcomes.reduce((sum, entry) => sum + entry.rows, 0);
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
  }

  // Coarser levels are rebuilt only when something was cleared: an additive
  // patch or a fresh bucket cascades correctly through the materialized
  // views on its own, which is why the common path pays no mutation at all.
  if (clears.length > 0) {
    try {
      await rebuildCoarserLevels(
        ctx,
        {
          family: "request",
          ownerPk,
          sets: hourSets(clears, ctx, namespace),
          externalIds: [],
          includeRaw: false,
        },
        stats,
      );
    } catch (err) {
      return ops.map((operation) => failed(operation.id, err));
    }
  }
  return ops.map((operation, index) =>
    ok(operation.id, index === 0 ? stats : undefined),
  );
}

function appTarget(
  ctx: EngineContext,
  namespace: string,
  app: string,
): AppTarget {
  const appId = id("app", namespace, app);
  const native = ctx.identity.native(appId);
  return {
    appPk: ctx.identity.requireNumber(appId, "pk"),
    versionPk: Number(native?.["activeVersionPk"] ?? 0),
    externalId: ctx.identity.requireString(appId, "externalId"),
    name: app,
    share: 1,
  };
}

function hourSets<
  S extends { app: string; epochHour: number; namespace: string },
>(ops: Operation<S>[], ctx: EngineContext, namespace: string): HourSet[] {
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

function externalIdsOf<S extends { app: string }>(
  ops: Operation<S>[],
  ctx: EngineContext,
  namespace: string,
): string[] {
  const names = new Set(
    ops.map(
      (operation) =>
        (operation.desired?.spec ?? operation.observed?.spec)?.app ?? "",
    ),
  );
  return [...names]
    .filter((name) => name !== "")
    .map((name) =>
      ctx.identity.requireString(id("app", namespace, name), "externalId"),
    );
}

function syntheticHours(
  writes: BucketWrite[],
  raw: boolean,
): Array<{
  start: number;
  count: number;
  perApp: number[];
  errPermille: number;
  raw: boolean;
}> {
  return writes.map((write) => ({
    start: write.epochHour * HOUR_SEC,
    count: write.count,
    perApp: [write.count],
    errPermille: write.errPermille,
    raw,
  }));
}

export const literalRequestAdapter: ResourceAdapter<RequestSpec> = {
  kind: "request",
  lane: "clickhouse",
  granularity: "resource",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<RequestSpec>[]> {
    const ownerPk = ownerPkOf(ctx, scope);
    if (ownerPk === null) {
      return [];
    }
    const body = await ctx.clickhouse.query(
      `SELECT app_id, toString(request_id), toUnixTimestamp64Milli(received_at),
              http_method, url_path, response_http_status, total_duration_microseconds,
              request_body_size, response_body_size, toString(client_ipv4)
         FROM ${ctx.clickhouse.database}.request_log
        WHERE app_owner_id = ${ownerPk}
          AND workload_id = toUUID('${SIM_LITERAL_WORKLOAD}')
        ORDER BY app_id, request_id FORMAT TSV`,
    );
    const observed: Array<Resource<RequestSpec>> = [];
    for (const line of body.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const columns = line.split("\t");
      const appId = ctx.identity.byNative("app", "pk", Number(columns[0]));
      if (appId === undefined) {
        continue;
      }
      const spec: RequestSpec = {
        namespace: scope.namespace,
        app: appId.segments[1],
        requestId: columns[1],
        atMs: Number(columns[2]),
        method: columns[3],
        path: columns[4],
        status: Number(columns[5]),
        durationUs: Number(columns[6]),
        ip: columns[9],
        requestBytes: Number(columns[7]),
        responseBytes: Number(columns[8]),
      };
      observed.push({
        id: id("request", scope.namespace, spec.app, spec.requestId),
        kind: "request",
        spec,
        fingerprint: literalFingerprint(spec),
        deps: [],
        policy: { prune: "delete", precision: "literal" },
      });
    }
    return observed;
  },

  diff(desired, observed) {
    return defaultDiff("clickhouse", desired, observed);
  },

  async apply(
    ops: Operation<RequestSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    const writes = ops.filter((operation) => operation.type !== "delete");
    const stats: Record<string, number> = {};
    const namespace =
      (ops[0].desired?.spec ?? ops[0].observed?.spec)?.namespace ?? "";
    const ownerPk = ctx.identity.requireNumber(
      id("namespace", namespace),
      "pk",
    );
    const deletes = ops.filter(
      (operation) => operation.type === "delete" || operation.type === "update",
    );
    try {
      if (deletes.length > 0) {
        const ids = deletes
          .map(
            (operation) =>
              (operation.observed?.spec ?? operation.desired?.spec)?.requestId,
          )
          .filter((value): value is string => value !== undefined)
          .map((value) => `toUUID('${value}')`);
        await ctx.clickhouse.query(
          `ALTER TABLE ${ctx.clickhouse.database}.request_log DELETE
             WHERE app_owner_id = ${ownerPk} AND workload_id = toUUID('${SIM_LITERAL_WORKLOAD}')
               AND request_id IN (${ids.join(",")}) SETTINGS mutations_sync = 2`,
          600_000,
        );
        stats["mutation:request_log_literals"] = 1;
      }
      if (writes.length > 0) {
        const domain = ctx.env["WASMER_APP_DOMAIN"] ?? "localhost";
        const rows = writes.map((operation) => {
          const spec = operation.desired?.spec as RequestSpec;
          const appId = id("app", spec.namespace, spec.app);
          const native = ctx.identity.native(appId);
          return JSON.stringify({
            node_id: SIM_NODE_UUID,
            node_global_ipv4: "127.0.0.1",
            workload_id: SIM_LITERAL_WORKLOAD,
            request_id: spec.requestId,
            external_id: ctx.identity.requireString(appId, "externalId"),
            received_at: new Date(spec.atMs)
              .toISOString()
              .replace("T", " ")
              .replace("Z", ""),
            total_duration_microseconds: spec.durationUs,
            client_ipv4: spec.ip,
            http_version: "HTTP/1.1",
            http_method: spec.method,
            request_domain: `${spec.app}.${domain}`,
            url_path: spec.path,
            outcome: spec.status >= 500 ? "error" : "success",
            response_http_status: spec.status,
            request_body_size: spec.requestBytes,
            response_from_cache: false,
            response_body_size: spec.responseBytes,
            app_id: ctx.identity.requireNumber(appId, "pk"),
            app_version_id: Number(native?.["activeVersionPk"] ?? 0),
            app_owner_id: ownerPk,
            app_owner_is_user: false,
            protocol: "https",
          });
        });
        await ctx.clickhouse.query(
          `INSERT INTO ${ctx.clickhouse.database}.request_log FORMAT JSONEachRow\n${rows.join("\n")}`,
        );
        stats["literalRequests"] = rows.length;
      }
      return ops.map((operation, index) =>
        ok(operation.id, index === 0 ? stats : undefined),
      );
    } catch (err) {
      return ops.map((operation) => failed(operation.id, err));
    }
  },
};

/** The declaration hashes the whole spec, so the observed side must hash
 * the same field set - a literal request is identified by its content. */
export function literalFingerprint(spec: RequestSpec): string {
  return fingerprint(spec);
}
