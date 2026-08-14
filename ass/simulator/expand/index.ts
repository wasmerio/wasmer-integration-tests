// EXPAND: declaration + seed + anchor -> the desired resource stream.
// Ordered by (kind, id) exactly as the contract requires, and produced
// lazily so a 200-app, 12-month world diffs without ever being
// materialized (section 9.1).

import { KIND_ORDER, type Resource, type ResourceKind } from "../model";
import type { Declaration } from "../scenario";
import { buildWorld, type World } from "./world";
import {
  expandApps,
  expandCronjobs,
  expandDatabases,
  expandDomains,
  expandIdentity,
  expandVersions,
  expandVolumes,
} from "./product";
import {
  bucketFacts,
  expandDatabaseUsage,
  expandLiteralRequests,
  expandLogLines,
  expandRequestBuckets,
  expandRequestDays,
  expandUsagePeriods,
  expandVolumeUsage,
  expandWorkloadBuckets,
  expandWorkloadDays,
} from "./telemetry";
import { expandBilling } from "./billing";

export { buildWorld } from "./world";
export type { World, WorldApp } from "./world";

/** Section 9.3: the row budget applies to the *plan*, not the world - a run
 * that would exceed it refuses before any write, naming the knob. */
export const DEFAULT_ROW_BUDGET = 25_000_000;

export class ExpansionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpansionError";
  }
}

type KindExpander = (world: World, drill?: Set<string>) => Generator<Resource>;

/** One entry per kind, in stream order. A new axis is one more line here
 * plus its lowering and adapter - invariant I8. */
const EXPANDERS: Array<[ResourceKind, KindExpander]> = [
  ["user", (world) => filterKind(expandIdentity(world), "user")],
  ["namespace", (world) => filterKind(expandIdentity(world), "namespace")],
  ["app", expandApps],
  ["app-version", expandVersions],
  ["domain", expandDomains],
  ["volume", expandVolumes],
  ["database", expandDatabases],
  ["cronjob", expandCronjobs],
  ["plan-version", (world) => filterKind(expandBilling(world), "plan-version")],
  ["subscription", (world) => filterKind(expandBilling(world), "subscription")],
  ["invoice", (world) => filterKind(expandBilling(world), "invoice")],
  ["request-day", expandRequestDays],
  ["request-bucket", expandRequestBuckets],
  ["request", expandLiteralRequests],
  ["workload-day", expandWorkloadDays],
  ["workload-bucket", expandWorkloadBuckets],
  ["log-line", expandLogLines],
  ["volume-usage", expandVolumeUsage],
  ["database-usage", expandDatabaseUsage],
  ["usage-period", expandUsagePeriods],
];

function* filterKind(
  source: Generator<Resource>,
  kind: ResourceKind,
): Generator<Resource> {
  for (const item of source) {
    if (item.kind === kind) {
      yield item;
    }
  }
}

/** `drill` (level-2 groups, `${app}/${epochDay}`) prunes bucket expansion:
 * on a converged world the planner never builds the resources it would
 * immediately discard, which is what keeps the no-op proportional to the
 * digest sweep rather than to the world. */
export function* expandKind(
  world: World,
  kind: ResourceKind,
  drill?: Set<string>,
): Generator<Resource> {
  const entry = EXPANDERS.find(([name]) => name === kind);
  if (entry === undefined) {
    return;
  }
  yield* entry[1](world, drill);
}

/** The desired stream. Kinds appear in KIND_ORDER; within a kind the
 * expanders yield in id order, so the planner can merge-join. */
export function* expandWorld(world: World): Generator<Resource> {
  for (const kind of KIND_ORDER) {
    yield* expandKind(world, kind);
  }
}

export interface ExpansionPlan {
  world: World;
  counts: Record<string, number>;
  rawRows: number;
  aggregateBuckets: number;
  totalRequests: number;
  lines: string[];
}

/** A costed summary of the expansion, without materializing the stream:
 * what `ass up --plan` prints and what the budget check refuses on. */
export function summarizeExpansion(world: World): ExpansionPlan {
  const counts: Record<string, number> = {};
  let rawRows = 0;
  let aggregateBuckets = 0;
  let totalRequests = 0;

  for (const kind of KIND_ORDER) {
    let count = 0;
    if (kind === "request-bucket") {
      for (const app of world.apps) {
        for (const fact of bucketFacts(world, app)) {
          count += 1;
          totalRequests += fact.requests;
          if (fact.mode === "raw") {
            rawRows += fact.requests;
          } else {
            aggregateBuckets += 1;
          }
        }
      }
    } else {
      for (const resource of expandKind(world, kind)) {
        count += resource === undefined ? 0 : 1;
      }
    }
    if (count > 0) {
      counts[kind] = count;
    }
  }

  const budget = world.telemetry?.rowBudget ?? DEFAULT_ROW_BUDGET;
  if (rawRows > budget) {
    throw new ExpansionError(
      `the plan projects ${rawRows.toLocaleString()} raw request rows inside the ` +
        `precision.raw window - over the row budget of ${budget.toLocaleString()}. ` +
        "Cut `telemetry.rps.base`, shrink `telemetry.precision.raw`, or raise " +
        "`telemetry.rowBudget`.",
    );
  }

  const lines: string[] = [];
  lines.push(
    `expansion: ${Object.entries(counts)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ")}`,
  );
  if (totalRequests > 0) {
    lines.push(
      `  telemetry: ${totalRequests.toLocaleString()} requests - ` +
        `${rawRows.toLocaleString()} as raw rows, ${aggregateBuckets.toLocaleString()} ` +
        "hours as aggregate states",
    );
  }
  return { world, counts, rawRows, aggregateBuckets, totalRequests, lines };
}

export function expandDeclaration(input: {
  declaration: Declaration;
  seed: number;
  anchorMs: number;
}): World {
  return buildWorld(input);
}
