// Telemetry expansion: request/workload buckets and their day digests,
// literal requests and logs, volume/database usage series, and the hourly
// usage-snapshot periods the usage page sums.
//
// Precision (section 7) is a property of a time range, resolved per app:
// a bucket inside the app's raw window - or holding a literal request -
// is `raw`, everything else is `aggregate`, and P1 is enforced here rather
// than discovered by a writer later.

import { digestFingerprint } from "../digest";
import { id, resource, type Resource } from "../model";
import { serverSideErrorCount } from "../traffic";
import { parseDurationMs, parseSizeBytes } from "../scenario";
import { usagePeriodFingerprint } from "../specs";
import type {
  DatabaseUsageSpec,
  DayDigestSpec,
  LogLineSpec,
  RequestBucketSpec,
  RequestSpec,
  UsagePeriodSpec,
  VolumeUsageSpec,
  WorkloadBucketSpec,
} from "../specs";
import {
  padDay,
  padHour,
  subresourceApps,
  type World,
  type WorldApp,
} from "./world";

const HOUR_SEC = 3600;

export interface BucketFacts {
  app: WorldApp;
  epochHour: number;
  mode: "aggregate" | "raw";
  requests: number;
  generated: number;
  literals: number;
  http5xx: number;
  errPermille: number;
}

function appsSorted(world: World): WorldApp[] {
  return [...world.apps].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/** One pass over the hour grid for one app, resolving precision and the
 * exact counts both the writer and the digest use. */
export function bucketFacts(world: World, app: WorldApp): BucketFacts[] {
  const traffic = world.traffic;
  if (traffic === null) {
    return [];
  }
  const rawFromSec = Math.floor((world.anchorMs - app.rawWindowMs) / 1000);
  const facts: BucketFacts[] = [];
  for (const hour of traffic.hours) {
    const epochHour = Math.floor(hour.start / HOUR_SEC);
    const literals = world.literals.get(`${app.name}/${epochHour}`) ?? [];
    const literalCount = literals.reduce(
      (sum, literal) => sum + literal.count,
      0,
    );
    const modelCount = hour.perApp[app.index] ?? 0;
    const requests = Math.max(modelCount, literalCount);
    const generated = requests - literalCount;
    const mode =
      hour.start >= rawFromSec || literalCount > 0 ? "raw" : "aggregate";
    const literal5xx = literals.reduce(
      (sum, literal) => sum + (literal.status >= 500 ? literal.count : 0),
      0,
    );
    facts.push({
      app,
      epochHour,
      mode,
      requests,
      generated,
      literals: literalCount,
      http5xx:
        serverSideErrorCount({
          count: generated,
          errPermille: hour.errPermille,
        }) + literal5xx,
      errPermille: hour.errPermille,
    });
  }
  return facts;
}

export function* expandRequestDays(world: World): Generator<Resource> {
  if (world.traffic === null || world.telemetry === undefined) {
    return;
  }
  for (const app of appsSorted(world)) {
    const byDay = new Map<number, BucketFacts[]>();
    for (const fact of bucketFacts(world, app)) {
      const day = Math.floor(fact.epochHour / 24);
      const list = byDay.get(day) ?? [];
      list.push(fact);
      byDay.set(day, list);
    }
    for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
      const members = byDay.get(day) as BucketFacts[];
      const spec: DayDigestSpec = {
        namespace: world.namespace,
        app: app.name,
        epochDay: day,
        members: members.length,
        sums: {
          requests: members.reduce((sum, fact) => sum + fact.requests, 0),
          http5xx: members.reduce((sum, fact) => sum + fact.http5xx, 0),
        },
        weighted: members.reduce(
          (sum, fact) => sum + fact.requests * ((fact.epochHour % 24) + 1),
          0,
        ),
      };
      yield {
        id: id("request-day", world.namespace, app.name, padDay(day)),
        kind: "request-day",
        spec,
        fingerprint: digestFingerprint(spec),
        deps: [id("app", world.namespace, app.name)],
        policy: { prune: "delete" },
      };
    }
  }
}

export function* expandRequestBuckets(
  world: World,
  drill?: Set<string>,
): Generator<Resource> {
  const telemetry = world.telemetry;
  if (world.traffic === null || telemetry === undefined) {
    return;
  }
  for (const app of appsSorted(world)) {
    for (const fact of bucketFacts(world, app)) {
      if (
        drill !== undefined &&
        !drill.has(`${app.name}/${Math.floor(fact.epochHour / 24)}`)
      ) {
        continue;
      }
      const spec: RequestBucketSpec = {
        namespace: world.namespace,
        app: app.name,
        epochHour: fact.epochHour,
        mode: fact.mode,
        requests: fact.requests,
        http5xx: fact.http5xx,
        errPermille: fact.errPermille,
        latency: {
          p50: telemetry.latency.p50,
          p95: telemetry.latency.p95,
          p99: telemetry.latency.p99,
        },
        literals: fact.literals,
        seed: world.seed,
      };
      yield resource<RequestBucketSpec>({
        id: id(
          "request-bucket",
          world.namespace,
          app.name,
          padHour(fact.epochHour),
        ),
        spec,
        deps: [id("app", world.namespace, app.name)],
        policy: { prune: "delete", precision: fact.mode },
      });
    }
  }
}

/** Literal requests: exact rows, exact durations, fingerprinted by content
 * so editing one rewrites exactly that one request. */
export function* expandLiteralRequests(world: World): Generator<Resource> {
  const entries: Array<{ app: string; spec: RequestSpec }> = [];
  for (const [bucketKey, literals] of world.literals) {
    const appName = bucketKey.slice(0, bucketKey.lastIndexOf("/"));
    for (const literal of literals) {
      for (let repeat = 0; repeat < literal.count; repeat++) {
        const requestId = literalRequestId(world.seed, literal.ordinal, repeat);
        entries.push({
          app: appName,
          spec: {
            namespace: world.namespace,
            app: appName,
            requestId,
            atMs: literal.atMs + repeat,
            method: literal.method,
            path: literal.path,
            status: literal.status,
            durationUs:
              literal.durationUs ??
              Math.round((literal.durationMs ?? 0) * 1000),
            ip: literal.ip,
            requestBytes: literal.requestBytes,
            responseBytes: literal.responseBytes,
          },
        });
      }
    }
  }
  entries.sort((a, b) =>
    a.app === b.app
      ? a.spec.requestId < b.spec.requestId
        ? -1
        : 1
      : a.app < b.app
        ? -1
        : 1,
  );
  for (const entry of entries) {
    yield resource<RequestSpec>({
      id: id("request", world.namespace, entry.app, entry.spec.requestId),
      spec: entry.spec,
      deps: [id("app", world.namespace, entry.app)],
      policy: { prune: "delete", precision: "literal" },
    });
  }
}

/** Deterministic v4-shaped UUID, seed-stable across reseeds. */
export function literalRequestId(
  seed: number,
  ordinal: number,
  repeat: number,
): string {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  const mix = (value: number): void => {
    h = Math.imul(h ^ value, 2654435761) >>> 0;
    h = ((h << 13) | (h >>> 19)) >>> 0;
  };
  mix(ordinal + 1);
  mix(repeat + 1);
  const part = (offset: number): string => {
    let value = h;
    for (let index = 0; index < offset; index++) {
      mix(index + 7);
      value = h;
    }
    return value.toString(16).padStart(8, "0");
  };
  const a = part(0);
  const b = part(1);
  const c = part(2);
  const d = part(3);
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-8${c.slice(1, 4)}-${c.slice(4, 8)}${d}`;
}

export function* expandWorkloadDays(world: World): Generator<Resource> {
  const traffic = world.traffic;
  if (traffic === null) {
    return;
  }
  for (const app of appsSorted(world)) {
    const byDay = new Map<
      number,
      Array<{ epochHour: number; cpuMillis: number; memoryTimeKbs: number }>
    >();
    traffic.workloadHours.forEach((hour) => {
      const epochHour = Math.floor(hour.start / HOUR_SEC);
      const day = Math.floor(epochHour / 24);
      const perApp = hour.perApp[app.index];
      const list = byDay.get(day) ?? [];
      list.push({
        epochHour,
        cpuMillis: perApp.cpuMillis,
        memoryTimeKbs: perApp.memoryTimeKbs,
      });
      byDay.set(day, list);
    });
    for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
      const members = byDay.get(day) as Array<{
        epochHour: number;
        cpuMillis: number;
        memoryTimeKbs: number;
      }>;
      const spec: DayDigestSpec = {
        namespace: world.namespace,
        app: app.name,
        epochDay: day,
        members: members.length,
        sums: {
          cpuMillis: members.reduce((sum, member) => sum + member.cpuMillis, 0),
          memoryTimeKbs: members.reduce(
            (sum, member) => sum + member.memoryTimeKbs,
            0,
          ),
        },
        weighted: members.reduce(
          (sum, member) =>
            sum + member.cpuMillis * ((member.epochHour % 24) + 1),
          0,
        ),
      };
      yield {
        id: id("workload-day", world.namespace, app.name, padDay(day)),
        kind: "workload-day",
        spec,
        fingerprint: digestFingerprint(spec),
        deps: [id("app", world.namespace, app.name)],
        policy: { prune: "delete" },
      };
    }
  }
}

export function* expandWorkloadBuckets(
  world: World,
  drill?: Set<string>,
): Generator<Resource> {
  const traffic = world.traffic;
  if (traffic === null) {
    return;
  }
  for (const app of appsSorted(world)) {
    for (const hour of traffic.workloadHours) {
      const epochHour = Math.floor(hour.start / HOUR_SEC);
      if (
        drill !== undefined &&
        !drill.has(`${app.name}/${Math.floor(epochHour / 24)}`)
      ) {
        continue;
      }
      const perApp = hour.perApp[app.index];
      yield resource<WorkloadBucketSpec>({
        id: id(
          "workload-bucket",
          world.namespace,
          app.name,
          padHour(epochHour),
        ),
        spec: {
          namespace: world.namespace,
          app: app.name,
          epochHour,
          cpuMillis: perApp.cpuMillis,
          memoryTimeKbs: perApp.memoryTimeKbs,
          ingressKb: perApp.ingressKb,
          egressKb: perApp.egressKb,
        },
        deps: [id("app", world.namespace, app.name)],
      });
    }
  }
}

/** Q-G: `app_logs` carries a 14-day TTL, so a declared log older than that
 * would vanish. Refused at plan time, naming the TTL, rather than clamped. */
export const APP_LOG_TTL_MS = 14 * 86_400_000;

export function* expandLogLines(world: World): Generator<Resource> {
  const sorted = [...world.logs].sort((a, b) =>
    a.app === b.app ? a.atMs - b.atMs : a.app < b.app ? -1 : 1,
  );
  for (const log of sorted) {
    if (world.anchorMs - log.atMs > APP_LOG_TTL_MS) {
      throw new Error(
        `telemetry.logs declares a line at ${log.at} for "${log.app}", older than ` +
          "the 14d TTL on ClickHouse app_logs - it would be deleted by the " +
          "server before anyone could read it. Move it inside 14d.",
      );
    }
    const tsNanos = `${Math.round(log.atMs)}000000`;
    yield resource<LogLineSpec>({
      id: id(
        "log-line",
        world.namespace,
        log.app,
        tsNanos,
        String(log.ordinal).padStart(5, "0"),
      ),
      spec: {
        namespace: world.namespace,
        app: log.app,
        tsNanos,
        stream: log.stream,
        message: log.message,
      },
      deps: [id("app", world.namespace, log.app)],
    });
  }
}

function seriesHours(world: World, every: string): number[] {
  const traffic = world.traffic;
  const historyMs =
    world.telemetry === undefined
      ? 0
      : parseDurationMs(world.telemetry.history);
  const stepMs = Math.max(3_600_000, parseDurationMs(every));
  const startMs = world.anchorMs - historyMs;
  const hours: number[] = [];
  if (traffic === null && historyMs === 0) {
    return hours;
  }
  for (let at = startMs; at < world.anchorMs; at += stepMs) {
    hours.push(Math.floor(at / 3_600_000));
  }
  return hours;
}

export function* expandVolumeUsage(world: World): Generator<Resource> {
  const block = world.declaration.apps?.volumes;
  if (block?.usage === undefined) {
    return;
  }
  const usage = block.usage;
  const mean = parseSizeBytes(usage.mean);
  const hours = seriesHours(world, usage.every);
  for (const app of subresourceApps(world, block.apps).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    for (let index = 0; index < block.perApp; index++) {
      const mountPath =
        index === 0 ? block.mountPath : `${block.mountPath}-${index + 1}`;
      const stream = world.random.fork(`volume-usage-${app.name}-${mountPath}`);
      for (const epochHour of hours) {
        const dayIndex = Math.floor(
          (epochHour * 3_600_000 -
            (world.anchorMs - hours.length * 3_600_000)) /
            86_400_000,
        );
        const sizeBytes = Math.round(
          mean * (1 + usage.growth * dayIndex) * (0.97 + 0.06 * stream.next()),
        );
        yield resource<VolumeUsageSpec>({
          id: id(
            "volume-usage",
            world.namespace,
            app.name,
            mountPath,
            padHour(epochHour),
          ),
          spec: {
            namespace: world.namespace,
            app: app.name,
            mountPath,
            epochHour,
            sizeBytes,
          },
          deps: [id("volume", world.namespace, app.name, mountPath)],
        });
      }
    }
  }
}

export function* expandDatabaseUsage(world: World): Generator<Resource> {
  const block = world.declaration.apps?.databases;
  if (block?.usage === undefined) {
    return;
  }
  const usage = block.usage;
  const mean = parseSizeBytes(usage.mean);
  const hours = seriesHours(world, usage.every);
  for (const app of subresourceApps(world, block.apps).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    for (let index = 0; index < block.perApp; index++) {
      const name = index === 0 ? block.name : `${block.name}_${index + 1}`;
      const stream = world.random.fork(`database-usage-${app.name}-${name}`);
      for (const epochHour of hours) {
        const dayIndex = Math.floor(
          (epochHour * 3_600_000 -
            (world.anchorMs - hours.length * 3_600_000)) /
            86_400_000,
        );
        const usageBytes = Math.round(
          mean * (1 + usage.growth * dayIndex) * (0.97 + 0.06 * stream.next()),
        );
        yield resource<DatabaseUsageSpec>({
          id: id(
            "database-usage",
            world.namespace,
            app.name,
            name,
            padHour(epochHour),
          ),
          spec: {
            namespace: world.namespace,
            app: app.name,
            database: name,
            epochHour,
            usageBytes,
          },
          deps: [id("database", world.namespace, app.name, name)],
        });
      }
    }
  }
}

/** The usage page's `used` figures sum these hourly rows; they are declared
 * state like everything else, so a drifted snapshot is a diff, not a silent
 * disagreement with ClickHouse. */
export function* expandUsagePeriods(world: World): Generator<Resource> {
  const traffic = world.traffic;
  if (traffic === null) {
    return;
  }
  const volumes = world.declaration.apps?.volumes;
  const databases = world.declaration.apps?.databases;
  const volumeBytes =
    volumes?.usage === undefined
      ? 0
      : parseSizeBytes(volumes.usage.mean) * volumes.apps * volumes.perApp;
  const dbBytes =
    databases?.usage === undefined
      ? 0
      : parseSizeBytes(databases.usage.mean) *
        databases.apps *
        databases.perApp;
  const domainCount = world.declaration.apps?.domains?.custom ?? 0;
  for (const [index, hour] of traffic.hours.entries()) {
    const workload = traffic.workloadHours[index];
    const cpuMillis = workload.perApp.reduce(
      (sum, app) => sum + app.cpuMillis,
      0,
    );
    const memoryKbs = workload.perApp.reduce(
      (sum, app) => sum + app.memoryTimeKbs,
      0,
    );
    const ingressKb = workload.perApp.reduce(
      (sum, app) => sum + app.ingressKb,
      0,
    );
    const egressKb = workload.perApp.reduce(
      (sum, app) => sum + app.egressKb,
      0,
    );
    const spec: UsagePeriodSpec = {
      namespace: world.namespace,
      resolution: "hour",
      startSec: hour.start,
      endSec: hour.start + HOUR_SEC,
      requests: hour.count,
      memoryGbh: memoryKbs / (1024 * 1024) / 3600,
      cpuHours: cpuMillis / 3_600_000,
      ingressBytes: ingressKb * 1024,
      egressBytes: egressKb * 1024,
      appCount: world.apps.length,
      domainCount,
      volumeBytes,
      dbBytes,
    };
    yield {
      id: id(
        "usage-period",
        world.namespace,
        "hour",
        padHour(Math.floor(hour.start / HOUR_SEC)),
      ),
      kind: "usage-period" as const,
      spec,
      fingerprint: usagePeriodFingerprint(spec),
      deps: [id("namespace", world.namespace)],
      policy: { prune: "delete" as const },
    };
  }
}
