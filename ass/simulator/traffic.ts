// The deterministic traffic model: one expansion, used identically by
// `--plan`, the writers, and the ledger's recorded projections, so what
// the plan prints, what lands in ClickHouse, and what the seeded e2e
// asserts are the same numbers by construction. Hour counts are keyed by
// absolute epoch hour (fork label), so reseeding with the same seed on the
// same day reproduces exact per-day totals.

import { parseDurationMs, parseSizeBytes } from "./scenario";
import { seededRandom } from "./random";

export const HOUR_MS = 3_600_000;

/** The slice of the telemetry declaration the model reads. `rawWindow` is
 * the resolved `precision.raw` window (see `expand/world.ts`). */
export interface TrafficTelemetry {
  history: string;
  rawWindow: string;
  rps: {
    base: number;
    spikes: Array<{ at: string; multiplier: number; duration: string }>;
    perApp: Record<string, number>;
  };
  errorRate: {
    base: number;
    bursts: Array<{ at: string; rate: number; duration: string }>;
  };
  resources: {
    cpuMillisPerRequest: { mean: number; stddev: number };
    memoryBytes: { mean: string; stddev: string };
  };
}

export interface TrafficHour {
  /** Epoch seconds of the hour start. */
  start: number;
  /** Total requests across the portfolio this hour. */
  count: number;
  /** Exact per-app request counts this hour; sums to `count`. */
  perApp: number[];
  /** 5xx share, in permille. */
  errPermille: number;
  /** True when the hour falls in the raw window (per-request rows). */
  raw: boolean;
}

export interface DailyProjection {
  date: string;
  requests: number;
  http5xx: number;
  memoryTimeKbs: number;
  wallCpuMillis: number;
}

export interface TrafficModel {
  hours: TrafficHour[];
  perApp: Array<{ weight: number }>;
  /** Per-workload-hour resource values, per app per hour (client-decided so
   * projections are exact). */
  workloadHours: Array<{
    start: number;
    perApp: Array<{
      cpuMillis: number;
      memoryTimeKbs: number;
      ingressKb: number;
      egressKb: number;
    }>;
  }>;
  daily: DailyProjection[];
  totalRequests: number;
  rawRequests: number;
  rawStart: number;
}

function diurnalFactor(hourOfDay: number): number {
  // Smooth day/night curve with mean ~1 and a mid-afternoon peak.
  return 1 + 0.35 * Math.sin(((hourOfDay - 9) / 24) * 2 * Math.PI);
}

/** Largest-share split of an hour's total across apps: exact sum, stable
 * order. */
export function splitCount(total: number, weights: number[]): number[] {
  const parts = weights.map((weight) => Math.floor(total * weight));
  let remainder = total - parts.reduce((sum, part) => sum + part, 0);
  for (let index = 0; remainder > 0; index = (index + 1) % parts.length) {
    parts[index] += 1;
    remainder -= 1;
  }
  return parts;
}

/** Map `telemetry.rps.perApp` (name-keyed) onto app indices; unknown names
 * refuse, naming the portfolio so the fix is a copy-paste. Returns
 * undefined when no override is declared (the all-ones fast path). */
export function resolvePerAppMultipliers(
  perApp: Record<string, number>,
  names: string[],
): number[] | undefined {
  const entries = Object.entries(perApp);
  if (entries.length === 0) {
    return undefined;
  }
  const multipliers = names.map(() => 1);
  for (const [name, factor] of entries) {
    const index = names.indexOf(name);
    if (index === -1) {
      throw new Error(
        `telemetry.rps.perApp names unknown app "${name}" — this seed's ` +
          `apps are: ${names.join(", ")}`,
      );
    }
    multipliers[index] = factor;
  }
  return multipliers;
}

export function expandTraffic(
  telemetry: TrafficTelemetry,
  seed: number,
  appCount: number,
  nowMs: number,
  multipliers?: number[],
): TrafficModel {
  const historyMs = parseDurationMs(telemetry.history);
  const rawWindowMs = parseDurationMs(telemetry.rawWindow);
  const endHour = Math.floor(nowMs / HOUR_MS);
  const hourCount = Math.max(1, Math.round(historyMs / HOUR_MS));
  const startHour = endHour - hourCount;
  const rawStartMs = nowMs - rawWindowMs;

  const root = seededRandom(seed);
  const weightStream = root.fork("app-weights");
  const weightsRaw = Array.from(
    { length: Math.max(1, appCount) },
    () => 0.4 + weightStream.next(),
  );
  const weightSum = weightsRaw.reduce((sum, weight) => sum + weight, 0);
  const weights = weightsRaw.map((weight) => weight / weightSum);
  if (multipliers !== undefined && multipliers.length !== weights.length) {
    throw new Error(
      `per-app multipliers cover ${multipliers.length} apps but the ` +
        `portfolio has ${weights.length}`,
    );
  }

  const spikes = telemetry.rps.spikes.map((spike) => ({
    from: nowMs + parseDurationMs(spike.at),
    to: nowMs + parseDurationMs(spike.at) + parseDurationMs(spike.duration),
    multiplier: spike.multiplier,
  }));
  const bursts = telemetry.errorRate.bursts.map((burst) => ({
    from: nowMs + parseDurationMs(burst.at),
    to: nowMs + parseDurationMs(burst.at) + parseDurationMs(burst.duration),
    permille: Math.round(burst.rate * 1000),
  }));
  const basePermille = Math.round(telemetry.errorRate.base * 1000);

  const hours: TrafficHour[] = [];
  for (let index = 0; index < hourCount; index++) {
    const hour = startHour + index;
    const hourStartMs = hour * HOUR_MS;
    const stream = root.fork(`traffic-h${hour}`);
    const jitter = 0.85 + 0.3 * stream.next();
    let count = telemetry.rps.base * 3600 * diurnalFactor(hour % 24) * jitter;
    for (const spike of spikes) {
      if (hourStartMs >= spike.from - HOUR_MS + 1 && hourStartMs < spike.to) {
        count *= spike.multiplier;
      }
    }
    let errPermille = basePermille;
    for (const burst of bursts) {
      if (hourStartMs >= burst.from - HOUR_MS + 1 && hourStartMs < burst.to) {
        errPermille = burst.permille;
      }
    }
    let perApp = splitCount(Math.max(0, Math.round(count)), weights);
    if (multipliers !== undefined) {
      perApp = perApp.map((part, app) => Math.round(part * multipliers[app]));
    }
    hours.push({
      start: hour * 3600,
      count: perApp.reduce((sum, part) => sum + part, 0),
      perApp,
      errPermille: Math.min(1000, errPermille),
      raw: hourStartMs >= rawStartMs,
    });
  }

  // Workload-hour resources, client-decided for exact projections.
  const memoryMeanKb =
    parseSizeBytes(telemetry.resources.memoryBytes.mean) / 1024;
  const cpuPerRequest = telemetry.resources.cpuMillisPerRequest;
  const workloadHours = hours.map((hour) => {
    const counts = hour.perApp;
    const stream = root.fork(`workload-h${hour.start}`);
    return {
      start: hour.start,
      perApp: counts.map((requests) => {
        const cpuMean = Math.max(1, cpuPerRequest.mean);
        const cpuMillis = Math.round(
          requests * stream.normal(cpuMean, cpuPerRequest.stddev, 0.2),
        );
        return {
          cpuMillis,
          // A continuously resident instance: mean bytes held for the hour,
          // expressed in the table's KB-seconds unit.
          memoryTimeKbs: Math.round(
            memoryMeanKb * 3600 * (0.9 + 0.2 * stream.next()),
          ),
          ingressKb: Math.round(
            (requests * (120 + 300 * stream.next())) / 1024,
          ),
          egressKb: Math.round(
            (requests * (800 + 4000 * stream.next())) / 1024,
          ),
        };
      }),
    };
  });

  const dailyMap = new Map<string, DailyProjection>();
  hours.forEach((hour, index) => {
    const date = new Date(hour.start * 1000).toISOString().slice(0, 10);
    let day = dailyMap.get(date);
    if (day === undefined) {
      day = {
        date,
        requests: 0,
        http5xx: 0,
        memoryTimeKbs: 0,
        wallCpuMillis: 0,
      };
      dailyMap.set(date, day);
    }
    day.requests += hour.count;
    // The 5xx stripe applies per app (row indices restart per app split),
    // so the exact count sums over the split, not the hour total.
    for (const appCount of hour.perApp) {
      day.http5xx += serverSideErrorCount({
        count: appCount,
        errPermille: hour.errPermille,
      });
    }
    for (const app of workloadHours[index].perApp) {
      day.memoryTimeKbs += app.memoryTimeKbs;
      day.wallCpuMillis += app.cpuMillis;
    }
  });

  const totalRequests = hours.reduce((sum, hour) => sum + hour.count, 0);
  const rawRequests = hours
    .filter((hour) => hour.raw)
    .reduce((sum, hour) => sum + hour.count, 0);

  return {
    hours,
    perApp: weights.map((weight) => ({ weight })),
    workloadHours,
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    totalRequests,
    rawRequests,
    rawStart: Math.floor(rawStartMs / 1000),
  };
}

/** The 5xx count the server-side generator will produce for an hour. The
 * writer marks a request 5xx when its per-row lane (row index modulo 1000)
 * is below the hour's permille — a deterministic stripe, so the exact count
 * is floor+partial rather than a hash expectation. */
export function serverSideErrorCount(hour: {
  count: number;
  errPermille: number;
}): number {
  const fullCycles = Math.floor(hour.count / 1000);
  const tail = hour.count % 1000;
  return fullCycles * hour.errPermille + Math.min(tail, hour.errPermille);
}
