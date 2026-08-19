// Additive delta seeding (trial-2 option B): when the only change between
// the held declaration and the requested one is a set of per-app traffic
// multipliers going *up*, the difference is pure extra rows for those apps
// — so `up` skips the world rebuild and inserts exactly the delta,
// turning a ~100 s reseed into seconds. Everything else falls back to the
// full rebuild, hard: exactness always wins over speed. Delta rows are
// covered by the existing owner-keyed teardown entry, so a crash mid-delta
// is cleaned like any other partial state (and the fallback rebuild is
// always safe).
//
// Exactness argument: per-hour counts are `round(share × m)` with `share`
// fixed by the seed, so counts are monotonic in m; the 5xx stripe is keyed
// by row index (`rr`), so generating delta rows with rr continuing from
// the held count reproduces the identical union a full seed of the new
// declaration would produce (counts, status classes, per-day projections).
// Sub-hour timestamp spacing and gauge snapshots differ cosmetically; the
// workload delta lands as one extra summary row per app-hour (rollups sum,
// so cpu/network totals stay exact; the daily "workloads" count gains one
// per surged app-hour — accepted and documented).

import { appNames } from "./names";
import { seededRandom } from "./random";
import { expandTraffic, resolvePerAppMultipliers } from "./traffic";
import type { TrafficModel } from "./traffic";
import { SimulatorClickHouse } from "./clients/clickhouse";
import { connectSimulatorPostgres } from "./clients/postgres";
import {
  insertAggregateHours,
  insertRawHours,
  insertWorkloadSummaries,
  type AppTarget,
  type ClickHouseRowsEntry,
} from "./seeders/telemetry";
import type { HeldDescriptor } from "./descriptor";
import type { SimulatorDeclaration } from "./schema";
import type { SimulatorIo } from "./registry";

export interface SurgeClassification {
  kind: "surge";
  /** app name -> [old multiplier, new multiplier], increases only. */
  surged: Record<string, [number, number]>;
}

export type DeltaClassification =
  | SurgeClassification
  | { kind: "other"; reason: string };

/** Is the new declaration the held one plus per-app multiplier increases?
 * Everything else (any other field, any decrease, missing/differing seed)
 * refuses — the caller then full-rebuilds. */
export function classifyDelta(
  held: SimulatorDeclaration,
  next: SimulatorDeclaration,
): DeltaClassification {
  if (held.seed === undefined || held.seed !== next.seed) {
    return { kind: "other", reason: "seed missing or changed" };
  }
  const strip = (declaration: SimulatorDeclaration): unknown => ({
    ...declaration,
    telemetry:
      declaration.telemetry === undefined
        ? undefined
        : {
            ...declaration.telemetry,
            rps: { ...declaration.telemetry.rps, perApp: undefined },
          },
  });
  if (JSON.stringify(strip(held)) !== JSON.stringify(strip(next))) {
    return { kind: "other", reason: "more than rps.perApp changed" };
  }
  if (held.telemetry === undefined || next.telemetry === undefined) {
    return { kind: "other", reason: "no telemetry block" };
  }
  const oldPerApp = held.telemetry.rps.perApp;
  const newPerApp = next.telemetry.rps.perApp;
  const names = new Set([...Object.keys(oldPerApp), ...Object.keys(newPerApp)]);
  const surged: Record<string, [number, number]> = {};
  for (const name of names) {
    const before = oldPerApp[name] ?? 1;
    const after = newPerApp[name] ?? 1;
    if (after < before) {
      return {
        kind: "other",
        reason: `rps.perApp.${name} decreases (${before} → ${after})`,
      };
    }
    if (after > before) {
      surged[name] = [before, after];
    }
  }
  if (Object.keys(surged).length === 0) {
    return { kind: "other", reason: "no multiplier increased" };
  }
  return { kind: "surge", surged };
}

export interface DeltaResult {
  addedRequests: number;
  perApp: Array<{ name: string; added: number }>;
  /** The new model's projections, for the descriptor update. */
  totalRequests: number;
  projectedDaily: TrafficModel["daily"];
}

export interface DeltaOptions {
  env: Record<string, string>;
  descriptor: HeldDescriptor;
  next: SimulatorDeclaration;
  io: SimulatorIo;
}

/** Insert exactly the surge's extra rows against the held world. Throws on
 * any precondition miss — the caller falls back to a full rebuild. */
export async function applyTelemetryDelta(
  options: DeltaOptions,
): Promise<DeltaResult> {
  const { env, descriptor, next, io } = options;
  const held = descriptor.declaration;
  const telemetryNew = next.telemetry;
  const telemetryOld = held?.telemetry;
  if (
    held === undefined ||
    telemetryOld === undefined ||
    telemetryNew === undefined
  ) {
    throw new Error("held declaration unavailable");
  }
  const entry = descriptor.teardown.find(
    (candidate) => candidate.kind === "clickhouse-rows",
  ) as unknown as (ClickHouseRowsEntry & { done?: boolean }) | undefined;
  if (entry === undefined || typeof entry.anchorMs !== "number") {
    throw new Error("held telemetry entry records no model anchor");
  }
  const seed = descriptor.seed;
  const appCount = next.apps?.count ?? 1;
  const names = appNames(seededRandom(seed).fork("fabricated-names"), appCount);
  const oldMultipliers = resolvePerAppMultipliers(
    telemetryOld.rps.perApp,
    names,
  );
  const newMultipliers = resolvePerAppMultipliers(
    telemetryNew.rps.perApp,
    names,
  );
  const oldModel = expandTraffic(
    telemetryOld,
    seed,
    appCount,
    entry.anchorMs,
    oldMultipliers,
  );
  const newModel = expandTraffic(
    telemetryNew,
    seed,
    appCount,
    entry.anchorMs,
    newMultipliers,
  );

  // Delta hours: per-app extras, with rr continuing where the held rows
  // stopped. Any negative delta means the classifier was wrong — abort.
  const deltaHours = newModel.hours.map((hour, index) => {
    const old = oldModel.hours[index];
    const perApp = hour.perApp.map((count, app) => {
      const delta = count - old.perApp[app];
      if (delta < 0) {
        throw new Error(
          `negative per-app delta at hour ${hour.start} — not additive`,
        );
      }
      return delta;
    });
    return { ...hour, perApp };
  });
  const offsetsPerApp = (app: number): number[] =>
    oldModel.hours.map((hour) => hour.perApp[app]);

  // App PKs come from the backend by the recorded external ids (the
  // descriptor stores them in name order — the trial-2 determinism fix).
  const externalIds = entry.appExternalIds;
  if (externalIds.length !== appCount) {
    throw new Error("held app list does not match the declaration");
  }
  const postgres = await connectSimulatorPostgres(env);
  let targets: AppTarget[];
  try {
    const rows = await postgres.query<{
      id: number;
      active_version_id: number | null;
      external_id: string;
    }>(
      `SELECT id, active_version_id, external_id FROM deploy_deployapp
       WHERE external_id = ANY($1::text[])`,
      [externalIds],
    );
    const byExternal = new Map(rows.rows.map((row) => [row.external_id, row]));
    targets = externalIds.map((externalId, index) => {
      const row = byExternal.get(externalId);
      if (row === undefined) {
        throw new Error(`held app ${externalId} not found in the backend`);
      }
      return {
        appPk: row.id,
        versionPk: row.active_version_id ?? row.id,
        externalId,
        name: names[index],
        share: newModel.perApp[index].weight,
      };
    });
  } finally {
    await postgres.end().catch(() => undefined);
  }

  const clickhouse = new SimulatorClickHouse(env);
  const ownerPk = entry.ownerId;
  const appDomain = env["WASMER_APP_DOMAIN"] ?? "localhost";
  const perAppAdded: Array<{ name: string; added: number }> = [];
  for (const [index, app] of targets.entries()) {
    const added = deltaHours.reduce((sum, hour) => sum + hour.perApp[index], 0);
    if (added === 0) {
      continue;
    }
    const offsets = offsetsPerApp(index);
    await insertAggregateHours(
      clickhouse,
      telemetryNew,
      { hours: deltaHours },
      app,
      index,
      ownerPk,
      seed,
      offsets,
    );
    await insertRawHours(
      clickhouse,
      telemetryNew,
      { hours: deltaHours },
      app,
      index,
      ownerPk,
      seed,
      appDomain,
      offsets,
    );
    // Workload delta: one extra summary row per hour carrying the request-
    // driven resource growth (memory is request-independent: delta 0 rows
    // are skipped by construction because cpu tracks requests).
    const deltaWorkloadHours = newModel.workloadHours.map((hour, h) => ({
      start: hour.start,
      perApp: hour.perApp.map((resources, app) => ({
        cpuMillis:
          resources.cpuMillis - oldModel.workloadHours[h].perApp[app].cpuMillis,
        memoryTimeKbs: 0,
        ingressKb:
          resources.ingressKb - oldModel.workloadHours[h].perApp[app].ingressKb,
        egressKb:
          resources.egressKb - oldModel.workloadHours[h].perApp[app].egressKb,
      })),
    }));
    await insertWorkloadSummaries(
      clickhouse,
      { workloadHours: deltaWorkloadHours },
      app,
      index,
      ownerPk,
    );
    perAppAdded.push({ name: app.name, added });
    io.err(`delta: ${app.name} +${added.toLocaleString()} requests`);
  }

  // Usage page: the snapshot table is unique per (owner, period,
  // resolution) — one row per hour already exists, so the delta is an
  // in-place UPDATE (found live: the append path trips
  // usage_metrics_periodicusagesnapshot_owner_period_resolution_uni).
  const snapshots = await connectSimulatorPostgres(env);
  try {
    const contentType = await snapshots.query<{ id: number }>(
      `SELECT id FROM django_content_type
       WHERE app_label = 'registry' AND model = 'namespace'`,
    );
    interface HourDelta {
      start: Date;
      requests: number;
      egressBytes: number;
      cpuHours: number;
      ingressBytes: number;
    }
    const deltas: HourDelta[] = [];
    newModel.hours.forEach((hour, index) => {
      const old = oldModel.hours[index];
      const deltaRequests = hour.count - old.count;
      if (deltaRequests <= 0) {
        return;
      }
      const resource = (
        pick: (app: {
          cpuMillis: number;
          ingressKb: number;
          egressKb: number;
        }) => number,
      ): number =>
        newModel.workloadHours[index].perApp.reduce(
          (sum, app, appIndex) =>
            sum +
            pick(app) -
            pick(oldModel.workloadHours[index].perApp[appIndex]),
          0,
        );
      deltas.push({
        start: new Date(hour.start * 1000),
        requests: deltaRequests,
        egressBytes: resource((app) => app.egressKb) * 1024,
        ingressBytes: resource((app) => app.ingressKb) * 1024,
        cpuHours: resource((app) => app.cpuMillis) / 3_600_000,
      });
    });
    const CHUNK = 500;
    for (let offset = 0; offset < deltas.length; offset += CHUNK) {
      const chunk = deltas.slice(offset, offset + CHUNK);
      const values: string[] = [];
      const params: unknown[] = [contentType.rows[0].id, ownerPk];
      for (const delta of chunk) {
        const base = params.length;
        values.push(
          `($${base + 1}::timestamptz, $${base + 2}::numeric, $${base + 3}::numeric, $${base + 4}::numeric, $${base + 5}::float8)`,
        );
        params.push(
          delta.start,
          delta.requests,
          delta.ingressBytes,
          delta.egressBytes,
          delta.cpuHours,
        );
      }
      await snapshots.query(
        `UPDATE usage_metrics_periodicusagesnapshot AS snapshot
         SET no_requests = snapshot.no_requests + delta.requests,
             network_ingress_bytes = snapshot.network_ingress_bytes + delta.ingress,
             network_egress_bytes = snapshot.network_egress_bytes + delta.egress,
             cpu_time_hours = snapshot.cpu_time_hours + delta.cpu
         FROM (VALUES ${values.join(",")})
           AS delta(started_at, requests, ingress, egress, cpu)
         WHERE snapshot.owner_content_type_id = $1
           AND snapshot.owner_object_id = $2
           AND snapshot.resolution = 'hour'
           AND snapshot.snapshot_started_at = delta.started_at`,
        params,
      );
    }
  } finally {
    await snapshots.end().catch(() => undefined);
  }

  return {
    addedRequests: newModel.totalRequests - oldModel.totalRequests,
    perApp: perAppAdded,
    totalRequests: newModel.totalRequests,
    projectedDaily: newModel.daily,
  };
}
