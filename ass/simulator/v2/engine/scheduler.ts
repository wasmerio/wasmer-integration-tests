// APPLY: dependency-staged, lane-parallel dispatch. Kinds whose
// dependencies are satisfied run concurrently, each adapter bounded by its
// lane semaphore, so the ClickHouse writes of one app overlap the Postgres
// writes of another and the SDK lane never waits on either.
//
// The only barrier in the design is A1 (delete before insert per ClickHouse
// table), and it lives inside the adapter that owns those tables - not
// here, because a global barrier would serialize lanes that share nothing.

import {
  KIND_ORDER,
  type OpResult,
  type Operation,
  type ResourceKind,
} from "../model";
import type { ResourceAdapter } from "../adapter";
import type { EngineContext } from "./context";

export interface ApplyReport {
  results: OpResult[];
  errors: string[];
  /** Per-kind wall clock, so a timing anomaly is attributable afterwards. */
  timings: Array<{ kind: ResourceKind; ms: number; ops: number }>;
  stats: Record<string, number>;
}

/** Longest-path staging over the kind-level dependency graph derived from
 * the operations themselves - not a hardcoded pipeline. */
export function stageKinds(
  operations: Operation[],
  adapters: Map<string, ResourceAdapter>,
): ResourceKind[][] {
  const present = new Set<ResourceKind>();
  const edges = new Map<ResourceKind, Set<ResourceKind>>();
  for (const operation of operations) {
    present.add(operation.kind);
    const dependencies = edges.get(operation.kind) ?? new Set<ResourceKind>();
    for (const dependency of operation.desired?.deps ?? []) {
      if (dependency.kind !== operation.kind) {
        dependencies.add(dependency.kind);
      }
    }
    edges.set(operation.kind, dependencies);
  }
  const depth = new Map<ResourceKind, number>();
  const resolve = (kind: ResourceKind, seen: Set<ResourceKind>): number => {
    const cached = depth.get(kind);
    if (cached !== undefined) {
      return cached;
    }
    if (seen.has(kind)) {
      return 0;
    }
    seen.add(kind);
    let level = 0;
    for (const dependency of edges.get(kind) ?? []) {
      if (!present.has(dependency)) {
        continue;
      }
      level = Math.max(level, resolve(dependency, seen) + 1);
    }
    depth.set(kind, level);
    return level;
  };
  for (const kind of present) {
    resolve(kind, new Set());
  }
  const stages: ResourceKind[][] = [];
  for (const kind of KIND_ORDER) {
    if (!present.has(kind) || adapters.get(kind)?.virtual === true) {
      continue;
    }
    const level = depth.get(kind) ?? 0;
    (stages[level] ??= []).push(kind);
  }
  return stages.filter((stage) => stage !== undefined && stage.length > 0);
}

function verbsOf(operations: Operation[]): string[] {
  return [...new Set(operations.map((operation) => operation.type))];
}

export async function applyPlan(input: {
  operations: Operation[];
  adapters: Map<string, ResourceAdapter>;
  ctx: EngineContext;
  /** Called as each kind finishes. Structured, not formatted: how a
   * reconcile *looks* is the renderer's decision, not the scheduler's. */
  onKindComplete?: (event: {
    kind: ResourceKind;
    ops: number;
    ms: number;
    failed: boolean;
    /** The distinct verbs this batch carried, so a reporter can say
     * "removed" where the batch removed things. */
    verbs: string[];
  }) => void;
}): Promise<ApplyReport> {
  const { ctx } = input;
  const byKind = new Map<ResourceKind, Operation[]>();
  for (const operation of input.operations) {
    const list = byKind.get(operation.kind) ?? [];
    list.push(operation);
    byKind.set(operation.kind, list);
  }
  // Creation runs parents-first; removal must run children-first, or a
  // foreign key refuses the delete. A kind whose operations are *only*
  // deletes is therefore scheduled in reverse dependency order, ahead of
  // everything else. Kinds with a mixed set keep one apply call and order
  // internally (the telemetry adapters must, to honour A1).
  const deleteOnly = new Set(
    [...byKind.entries()]
      .filter(([, operations]) =>
        operations.every((operation) => operation.type === "delete"),
      )
      .map(([kind]) => kind),
  );
  const teardownStages = stageKinds(
    input.operations.filter((operation) => deleteOnly.has(operation.kind)),
    input.adapters,
  ).reverse();
  const buildStages = stageKinds(
    input.operations.filter((operation) => !deleteOnly.has(operation.kind)),
    input.adapters,
  );
  const stages = [...teardownStages, ...buildStages];
  const report: ApplyReport = {
    results: [],
    errors: [],
    timings: [],
    stats: {},
  };

  // A kind whose dependency failed cannot succeed - its bindings do not
  // exist - and letting it try produces hundreds of derived errors that
  // bury the one that matters. It is skipped and reported once; the next
  // reconcile observes reality and converges (section 8.4).
  const failedKinds = new Set<ResourceKind>();
  const dependenciesOf = (kind: ResourceKind): Set<ResourceKind> => {
    const dependencies = new Set<ResourceKind>();
    for (const operation of byKind.get(kind) ?? []) {
      for (const dependency of operation.desired?.deps ?? []) {
        dependencies.add(dependency.kind);
      }
    }
    return dependencies;
  };

  for (const stage of stages) {
    const runs = stage.map(async (kind) => {
      const operations = byKind.get(kind) ?? [];
      const adapter = input.adapters.get(kind);
      if (adapter === undefined || operations.length === 0) {
        return;
      }
      const blocked = [...dependenciesOf(kind)].filter((dependency) =>
        failedKinds.has(dependency),
      );
      if (blocked.length > 0) {
        failedKinds.add(kind);
        report.errors.push(
          `${kind}: skipped - ${blocked.join(", ")} failed, so its identifiers do not exist yet`,
        );
        return;
      }
      const started = Date.now();
      try {
        const results = await adapter.apply(operations, ctx);
        report.results.push(...results);
        const seen = new Set<string>();
        for (const result of results) {
          if (!result.ok) {
            failedKinds.add(kind);
            // One line per distinct failure: 144 buckets failing for the
            // same reason is one problem, not 144.
            const message = result.error ?? "failed";
            if (!seen.has(message)) {
              seen.add(message);
              const repeats = results.filter(
                (other) => other.error === message,
              ).length;
              report.errors.push(
                `${kind}: ${message}${repeats > 1 ? ` (x${repeats})` : ""}`,
              );
            }
          }
          for (const [name, value] of Object.entries(result.stats ?? {})) {
            report.stats[name] = (report.stats[name] ?? 0) + value;
          }
        }
      } catch (err) {
        // A lane failure never masks another lane's: the next reconcile
        // observes whatever landed and converges (section 8.4).
        failedKinds.add(kind);
        report.errors.push(
          `${kind}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const ms = Date.now() - started;
      report.timings.push({ kind, ms, ops: operations.length });
      input.onKindComplete?.({
        kind,
        ops: operations.length,
        ms,
        failed: failedKinds.has(kind),
        verbs: verbsOf(operations),
      });
    });
    await Promise.all(runs);
  }
  assertMutationStats(report.stats);
  return report;
}

/** Section 9.3, mutation budget: one coalesced `ALTER ... DELETE` per table
 * per reconcile. More than that is a planner or adapter bug, and it is
 * cheaper to say so than to pay 2.4s per extra mutation. */
export function assertMutationStats(stats: Record<string, number>): void {
  const offenders = Object.entries(stats).filter(
    ([name, value]) => name.startsWith("mutation:") && value > 1,
  );
  if (offenders.length > 0) {
    throw new Error(
      "mutation budget exceeded - " +
        offenders
          .map(([name, value]) => `${name.slice("mutation:".length)} x${value}`)
          .join(", ") +
        " (section 8.3 A1: one ALTER ... DELETE per table per reconcile)",
    );
  }
}
