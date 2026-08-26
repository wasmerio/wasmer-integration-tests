// The loop (section 8):
//
//   EXPAND    declaration + seed + anchor -> desired resource stream (pure)
//   OBSERVE   platform -> observed stream + identity bindings (read-only)
//   DIFF      merge-join both streams by (kind, id) -> Operation[] (pure)
//   APPLY     scheduler -> lanes -> adapter.apply(batch)
//   VERIFY    re-OBSERVE + DIFF must be empty (optional)
//
// OBSERVE is two-level: one digest sweep per telemetry family, then hourly
// drill-down only for the (app, day) groups whose digest differs. An
// unchanged world never leaves level 1, which is what delivers "do only
// what differs" at scale rather than in principle.

import {
  KIND_ORDER,
  key,
  type Digest,
  type Resource,
  type ResourceKind,
} from "../model";
import type { ResourceAdapter, Scope } from "../adapter";
import { expandKind } from "../expand";
import type { World } from "../expand/world";
import { planReconcile, type Plan } from "../plan";
import { applyPlan, type ApplyReport } from "./scheduler";
import type { EngineContext } from "./context";

/** Kinds observed before anything else: every later observation needs their
 * bindings to translate a store identifier back into a natural key. A
 * volume's usage series is keyed by the volume's UUID and a database's by
 * its PK, so those two belong here as well - observing them concurrently
 * with their series would read an empty binding map and re-create rows that
 * already exist. */
const IDENTITY_KINDS: ResourceKind[] = [
  "user",
  "namespace",
  "app",
  "app-version",
  "volume",
  "database",
];

/** Telemetry families with a level-1 digest. */
const DIGEST_KINDS: ResourceKind[] = ["request-day", "workload-day"];

const BUCKET_KINDS = new Set<ResourceKind>([
  "request-bucket",
  "workload-bucket",
]);

export interface ReconcileInput {
  world: World;
  ctx: EngineContext;
  adapters: Map<ResourceKind, ResourceAdapter>;
  /** Two-sided telemetry diffing: CI's mode, and teardown's. */
  exact: boolean;
  /** Reconcile to the empty set. */
  toEmpty?: boolean;
  previousDigests: Map<string, string>;
  /** Per-app raw-window start of the previous reconcile (P3). */
  previousRawFrom: Map<string, number>;
  onKindComplete?: (event: {
    kind: ResourceKind;
    ops: number;
    ms: number;
    failed: boolean;
    verbs: string[];
  }) => void;
  /** Called once with the plan, before anything is applied. */
  onPlan?: (plan: Plan) => void;
}

/** This reconcile's per-app raw-window start, for the ledger. */
export function rawFromOf(world: World): Record<string, number> {
  const rawFrom: Record<string, number> = {};
  for (const app of world.apps) {
    rawFrom[app.name] = Math.floor((world.anchorMs - app.rawWindowMs) / 1000);
  }
  return rawFrom;
}

export interface ReconcileResult {
  plan: Plan;
  scope: Scope;
  /** Desired day digests of this reconcile - what the ledger records. */
  desiredDigests: Map<string, string>;
  drill: Set<string>;
  observeMs: number;
  diffMs: number;
  counts: Record<string, number>;
}

function historyWindow(world: World): { fromSec: number; toSec: number } {
  const traffic = world.traffic;
  if (traffic === null || traffic.hours.length === 0) {
    return { fromSec: world.anchorSec, toSec: world.anchorSec };
  }
  return {
    fromSec: traffic.hours[0].start,
    toSec: traffic.hours[traffic.hours.length - 1].start + 3600,
  };
}

export function scopeOf(world: World, widen = false): Scope {
  const window = historyWindow(world);
  return {
    namespace: world.namespace,
    username: world.username,
    scenario: world.scenario,
    pinned: world.pinned,
    anchorMs: world.anchorMs,
    // Teardown and `--exact` widen the window: state outside the declared
    // history is still simulator-owned and must be removable.
    fromSec: widen ? 0 : window.fromSec,
    toSec: widen ? world.anchorSec + 86_400 : window.toSec,
  };
}

/** EXPAND + OBSERVE + DIFF. Writes nothing - `ass diff` stops here. */
export async function planReconciliation(
  input: ReconcileInput,
): Promise<ReconcileResult> {
  const { world, ctx, adapters } = input;
  const started = Date.now();
  const scope = scopeOf(world, input.toEmpty === true || input.exact);

  // Level 0: identity, in dependency order. Everything else needs these
  // bindings, so they are the one part of OBSERVE that is sequential.
  const observed = new Map<ResourceKind, Resource[]>();
  for (const kind of IDENTITY_KINDS) {
    const adapter = adapters.get(kind);
    if (adapter !== undefined) {
      observed.set(kind, await adapter.observe(scope, ctx));
    }
  }

  // Level 1: digests, in parallel with the remaining product-axis reads.
  const desiredDigests = collectDesiredDigests(world, input.toEmpty === true);
  const [observedDigests] = await Promise.all([
    collectObservedDigests(scope, ctx, adapters),
    (async () => {
      const rest = KIND_ORDER.filter(
        (kind) =>
          !IDENTITY_KINDS.includes(kind) &&
          !DIGEST_KINDS.includes(kind) &&
          !BUCKET_KINDS.has(kind) &&
          adapters.has(kind),
      );
      await Promise.all(
        rest.map(async (kind) => {
          const adapter = adapters.get(kind) as ResourceAdapter;
          observed.set(kind, await adapter.observe(scope, ctx));
        }),
      );
    })(),
  ]);

  // A day is drilled when its digest differs, is missing on either side, or
  // when the run is exact (which must compare every member).
  const drill = new Set<string>();
  const groups = new Set<string>([
    ...desiredDigests.keys(),
    ...observedDigests.keys(),
  ]);
  for (const group of groups) {
    if (
      input.exact ||
      desiredDigests.get(group) !== observedDigests.get(group)
    ) {
      const segments = group.split(":")[1]?.split("/") ?? [];
      drill.add(`${segments[1]}/${Number(segments[2])}`);
    }
  }

  // Level 2: hourly buckets, only for the flagged groups.
  const bucketScope: Scope = { ...scope, drill };
  await Promise.all(
    [...BUCKET_KINDS]
      .filter((kind) => adapters.has(kind))
      .map(async (kind) => {
        const adapter = adapters.get(kind) as ResourceAdapter;
        observed.set(kind, await adapter.observe(bucketScope, ctx));
      }),
  );
  const observeMs = Date.now() - started;

  const diffStarted = Date.now();
  const plan = planReconcile({
    desired: input.toEmpty === true ? [] : desiredStream(world, drill),
    observed: observedStream(observed),
    adapters: adapters as Map<string, ResourceAdapter>,
    diffContext: {
      exact: input.exact,
      previousDigests: input.previousDigests,
      desiredDigests,
      previousRawFrom: input.previousRawFrom,
      reportSurplus: () => undefined,
    },
  });

  const counts: Record<string, number> = {};
  for (const [kind, resources] of observed) {
    counts[kind] = resources.length;
  }
  return {
    plan,
    scope,
    desiredDigests,
    drill,
    observeMs,
    diffMs: Date.now() - diffStarted,
    counts,
  };
}

/** EXPAND + OBSERVE + DIFF + APPLY, with an optional verification pass. */
export async function reconcile(
  input: ReconcileInput & { verify?: boolean },
): Promise<{
  result: ReconcileResult;
  report: ApplyReport | null;
  verified: Plan | null;
}> {
  const result = await planReconciliation(input);
  input.onPlan?.(result.plan);
  if (result.plan.operations.length === 0) {
    return { result, report: null, verified: null };
  }
  const report = await applyPlan({
    operations: result.plan.operations,
    adapters: input.adapters as Map<string, ResourceAdapter>,
    ctx: input.ctx,
    onKindComplete: input.onKindComplete,
  });
  let verified: Plan | null = null;
  if (input.verify === true && report.errors.length === 0) {
    verified = (await planReconciliation(input)).plan;
  }
  return { result, report, verified };
}

function* desiredStream(world: World, drill: Set<string>): Generator<Resource> {
  for (const kind of KIND_ORDER) {
    yield* expandKind(world, kind, drill);
  }
}

function* observedStream(
  observed: Map<ResourceKind, Resource[]>,
): Generator<Resource> {
  for (const kind of KIND_ORDER) {
    const resources = observed.get(kind);
    if (resources === undefined) {
      continue;
    }
    // Adapters may emit in any order within their kind; the merge-join
    // needs (kind, id), and sorting here keeps that guarantee in one place.
    const sorted = [...resources].sort((a, b) =>
      a.id.segments.join("/") < b.id.segments.join("/") ? -1 : 1,
    );
    yield* sorted;
  }
}

function collectDesiredDigests(
  world: World,
  toEmpty: boolean,
): Map<string, string> {
  const digests = new Map<string, string>();
  if (toEmpty) {
    return digests;
  }
  for (const kind of DIGEST_KINDS) {
    for (const resource of expandKind(world, kind)) {
      digests.set(key(resource.id), resource.fingerprint);
    }
  }
  return digests;
}

async function collectObservedDigests(
  scope: Scope,
  ctx: EngineContext,
  adapters: Map<ResourceKind, ResourceAdapter>,
): Promise<Map<string, string>> {
  const results = await Promise.all(
    DIGEST_KINDS.map(async (kind) => {
      const adapter = adapters.get(kind);
      if (adapter?.observeDigests === undefined) {
        return [] as Digest[];
      }
      return adapter.observeDigests(scope, ctx);
    }),
  );
  const digests = new Map<string, string>();
  for (const digest of results.flat()) {
    digests.set(key(digest.id), digest.fingerprint);
  }
  return digests;
}
