// The declaration half's shared derivation: everything a scenario means,
// resolved once, with no I/O and no store name anywhere. Pure in
// (declaration, seed, anchorHour) - invariant I6 - so `ass diff --dry`
// runs with no platform at all and every expansion is unit-testable.

import {
  appTrafficShares,
  splitCount,
  expandTraffic,
  type TrafficModel,
  type TrafficTelemetry,
} from "../traffic";
import { appNames } from "../names";
import { seededRandom, type Random } from "../random";
import { FIXTURE_NAMES, type FixtureName } from "../fixtures";
import {
  parseDurationMs,
  parseSizeBytes,
  parseOffsetMs,
  type AppsBlock,
  type Declaration,
  type LiteralLog,
  type LiteralRequest,
  type TelemetryBlock,
} from "../scenario";

export const HOUR_SEC = 3600;
export const DAY_SEC = 86_400;

/** Default number of really-deployed apps (section 13). Real creation costs
 * seconds each, so the rest of a portfolio is fabricated by declaration,
 * not by an engine heuristic. */
export const DEFAULT_REAL_APPS = 12;

export interface WorldApp {
  index: number;
  name: string;
  fixture: FixtureName;
  /** section 13: "deployed" goes through the API, "fabricated" is a direct
   * write by definition. */
  realism: "deployed" | "fabricated";
  /** Count-stable traffic share (mean ~1), from `appTrafficShares`. */
  weight: number;
  /** Per-app raw precision window in ms, from `telemetry.precision`. */
  rawWindowMs: number;
}

export interface BucketLiteral extends LiteralRequest {
  /** Absolute epoch milliseconds, resolved against the anchor. */
  atMs: number;
  /** Stable per-declaration ordinal, so a request id is reproducible. */
  ordinal: number;
}

export interface World {
  declaration: Declaration;
  scenario: string;
  seed: number;
  /** Reconcile anchor, floored to the hour (section 8.2). */
  anchorMs: number;
  anchorSec: number;
  namespace: string;
  username: string;
  password: string;
  pinned: boolean;
  apps: WorldApp[];
  appsByName: Map<string, WorldApp>;
  telemetry: TelemetryBlock | undefined;
  /** The proven traffic expansion, anchored at `anchorMs`. */
  traffic: TrafficModel | null;
  /** Literal requests keyed by `${app}/${epochHour}` (they force their
   * bucket to raw - P1). */
  literals: Map<string, BucketLiteral[]>;
  logs: Array<LiteralLog & { atMs: number; ordinal: number }>;
  random: Random;
}

function fixtureAssignments(
  fixture: AppsBlock["fixture"],
  count: number,
  random: Random,
): FixtureName[] {
  const mix =
    typeof fixture === "string"
      ? [{ fixture, weight: 1 }]
      : FIXTURE_NAMES.filter((name) => fixture[name] !== undefined).map(
          (name) => ({
            fixture: name,
            weight: fixture[name] as number,
          }),
        );
  const total = mix.reduce((sum, entry) => sum + entry.weight, 0);
  const counts = splitCount(
    count,
    mix.map((entry) => entry.weight / total),
  );
  const assigned: FixtureName[] = [];
  mix.forEach((entry, index) => {
    for (let repeat = 0; repeat < counts[index]; repeat++) {
      assigned.push(entry.fixture as FixtureName);
    }
  });
  // The shuffle keeps its historical fork label, so a given seed keeps
  // assigning the same fixtures it always has (invariant I5).
  const stream = random.fork("fixture-assignment");
  for (let i = assigned.length - 1; i > 0; i--) {
    const j = stream.int(0, i);
    [assigned[i], assigned[j]] = [assigned[j], assigned[i]];
  }
  return assigned;
}

export function floorToHour(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000;
}

export function buildWorld(input: {
  declaration: Declaration;
  seed: number;
  anchorMs: number;
}): World {
  const { declaration, seed } = input;
  const anchorMs = floorToHour(input.anchorMs);
  const random = seededRandom(seed);
  const appsBlock = declaration.apps;
  const count = appsBlock?.count ?? 0;
  // The historical fork label, so a given seed names the same portfolio
  // it always has - which is what makes invariant I5 checkable.
  const names = appNames(seededRandom(seed).fork("fabricated-names"), count);
  const fixtures =
    appsBlock === undefined
      ? []
      : fixtureAssignments(appsBlock.fixture, count, seededRandom(seed));
  const realCount = Math.min(
    count,
    appsBlock?.real ?? Math.min(count, DEFAULT_REAL_APPS),
  );

  const telemetry = declaration.telemetry;
  const defaultRawMs =
    telemetry === undefined ? 0 : parseDurationMs(telemetry.precision.raw);
  // Count-stable per-app traffic shares, shared with the traffic model.
  const shares = appTrafficShares(seed, count);

  const apps: WorldApp[] = names.map((name, index) => ({
    index,
    name,
    fixture: fixtures[index] ?? "static-site",
    realism: index < realCount ? "deployed" : "fabricated",
    weight: shares[index],
    rawWindowMs:
      telemetry === undefined
        ? 0
        : telemetry.precision.apps[name] !== undefined
          ? parseDurationMs(telemetry.precision.apps[name].raw)
          : defaultRawMs,
  }));
  const appsByName = new Map(apps.map((app) => [app.name, app]));

  let traffic: TrafficModel | null = null;
  if (telemetry !== undefined && count > 0) {
    const multipliers = resolveMultipliers(telemetry.rps.perApp, names);
    traffic = expandTraffic(
      {
        history: telemetry.history,
        rawWindow: telemetry.precision.raw,
        // zod fills the defaults at parse time; the inferred type keeps
        // them optional, so the runtime-complete blocks are asserted.
        rps: telemetry.rps as TrafficTelemetry["rps"],
        errorRate: telemetry.errorRate as TrafficTelemetry["errorRate"],
        resources: telemetry.resources as TrafficTelemetry["resources"],
      },
      seed,
      count,
      anchorMs,
      multipliers,
    );
  }

  const literals = new Map<string, BucketLiteral[]>();
  telemetry?.requests.forEach((request, ordinal) => {
    const app = appsByName.get(request.app);
    if (app === undefined) {
      throw new Error(
        `telemetry.requests names unknown app "${request.app}" - this seed's apps are: ${names.join(", ")}`,
      );
    }
    const atMs = anchorMs + parseOffsetMs(request.at);
    const epochHour = Math.floor(atMs / 3_600_000);
    const bucketKey = `${request.app}/${epochHour}`;
    const list = literals.get(bucketKey) ?? [];
    list.push({ ...request, atMs, ordinal });
    literals.set(bucketKey, list);
  });

  const logs = (telemetry?.logs ?? []).map((log, ordinal) => {
    if (!appsByName.has(log.app)) {
      throw new Error(
        `telemetry.logs names unknown app "${log.app}" - this seed's apps are: ${names.join(", ")}`,
      );
    }
    return { ...log, atMs: anchorMs + parseOffsetMs(log.at), ordinal };
  });

  return {
    declaration,
    scenario: declaration.name,
    seed,
    anchorMs,
    anchorSec: Math.floor(anchorMs / 1000),
    namespace: declaration.account.namespace,
    username: declaration.account.username,
    password: declaration.account.password,
    pinned: declaration.account.pinned,
    apps,
    appsByName,
    telemetry,
    traffic,
    literals,
    logs,
    random,
  };
}

function resolveMultipliers(
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
        `telemetry.rps.perApp names unknown app "${name}" - this seed's apps are: ${names.join(", ")}`,
      );
    }
    multipliers[index] = factor;
  }
  return multipliers;
}

/** Which apps carry a subresource, in portfolio order. */
export function subresourceApps(world: World, apps: number): WorldApp[] {
  return world.apps.slice(0, Math.min(apps, world.apps.length));
}

/** Deterministic usage series value for an hour offset within the window. */
export function usageValue(
  meanBytes: string,
  growth: number,
  dayIndex: number,
  jitter: number,
): number {
  const mean = parseSizeBytes(meanBytes);
  return Math.round(mean * (1 + growth * dayIndex) * (0.97 + 0.06 * jitter));
}

/** Zero-padded so segment comparison is also numeric order (section 4). */
export function padHour(epochHour: number): string {
  return String(epochHour).padStart(9, "0");
}

export function padDay(epochDay: number): string {
  return String(epochDay).padStart(7, "0");
}
