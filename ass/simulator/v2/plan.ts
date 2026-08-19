// DIFF: a merge-join of two sorted resource streams, emitting operations
// as it goes. Pure - it consumes resources and produces operations, and is
// therefore table-testable with no fixtures at all.

import {
  compareIds,
  key,
  type Operation,
  type Resource,
  type Surplus,
} from "./model";
import type { DiffContext, ResourceAdapter } from "./adapter";

export interface Plan {
  operations: Operation[];
  surplus: Surplus[];
  /** Resources compared and left alone - invariant I3's evidence. */
  keeps: number;
  counts: Record<string, Record<string, number>>;
}

export interface PlanInput {
  desired: Iterable<Resource>;
  observed: Iterable<Resource>;
  adapters: Map<string, ResourceAdapter>;
  diffContext: DiffContext;
  /** Bucket kinds outside the drill set are not compared at all (level 1
   * said the day matches, and I9 makes that sound). */
  skip?: (resource: Resource) => boolean;
}

function nextOf<T>(iterator: Iterator<T>): T | null {
  const step = iterator.next();
  return step.done === true ? null : step.value;
}

export function planReconcile(input: PlanInput): Plan {
  const operations: Operation[] = [];
  const surplus: Surplus[] = [];
  const counts: Record<string, Record<string, number>> = {};
  let keeps = 0;

  const diffContext: DiffContext = {
    ...input.diffContext,
    reportSurplus(entry) {
      surplus.push({
        id: entry.id,
        kind: entry.id.kind,
        desired: entry.desired,
        observed: entry.observed,
      });
      input.diffContext.reportSurplus(entry);
    },
  };

  const record = (operation: Operation): void => {
    const perKind = (counts[operation.kind] ??= {});
    perKind[operation.type] = (perKind[operation.type] ?? 0) + 1;
    operations.push(operation);
  };

  const emit = (desired: Resource | null, observed: Resource | null): void => {
    const kind = (desired ?? observed)?.kind;
    if (kind === undefined) {
      return;
    }
    const adapter = input.adapters.get(kind);
    if (adapter === undefined || adapter.virtual === true) {
      return;
    }
    if (desired !== null && input.skip?.(desired) === true) {
      return;
    }
    const produced = adapter.diff(desired, observed, diffContext);
    if (produced.length === 0) {
      keeps += 1;
      return;
    }
    for (const operation of produced) {
      record(operation);
    }
  };

  // The merge-join is only correct on sorted streams, and an expander that
  // yields out of order fails as a plan full of creates and deletes - a
  // confusing symptom for a mechanical bug. Check it instead.
  const ordered = (side: string) => {
    let previous: Resource | null = null;
    return (next: Resource | null): Resource | null => {
      if (
        next !== null &&
        previous !== null &&
        compareIds(previous.id, next.id) > 0
      ) {
        throw new Error(
          `${side} stream is out of order: ${key(previous.id)} came before ${key(next.id)} ` +
            "(streams must be sorted by (kind, id) - see the contract in model.ts)",
        );
      }
      previous = next;
      return next;
    };
  };
  const checkDesired = ordered("desired");
  const checkObserved = ordered("observed");
  const desiredIterator = input.desired[Symbol.iterator]();
  const observedIterator = input.observed[Symbol.iterator]();
  let desired = checkDesired(nextOf(desiredIterator));
  let observed = checkObserved(nextOf(observedIterator));

  while (desired !== null || observed !== null) {
    if (desired === null) {
      emit(null, observed);
      observed = checkObserved(nextOf(observedIterator));
      continue;
    }
    if (observed === null) {
      emit(desired, null);
      desired = checkDesired(nextOf(desiredIterator));
      continue;
    }
    const order = compareIds(desired.id, observed.id);
    if (order === 0) {
      emit(desired, observed);
      desired = checkDesired(nextOf(desiredIterator));
      observed = checkObserved(nextOf(observedIterator));
    } else if (order < 0) {
      emit(desired, null);
      desired = checkDesired(nextOf(desiredIterator));
    } else {
      emit(null, observed);
      observed = checkObserved(nextOf(observedIterator));
    }
  }

  return { operations, surplus, keeps, counts };
}

export function planIsEmpty(plan: Plan): boolean {
  return plan.operations.length === 0;
}

// Rendering lives in `render.ts`: a plan is read by a human under time
// pressure, and how it looks is a design decision of its own.

/** Section 9.3: more than one coalesced delete per ClickHouse table per
 * reconcile is a planner bug (A1), so the plan says so before applying. */
export function assertMutationBudget(plan: Plan): void {
  const perTable = new Map<string, number>();
  for (const operation of plan.operations) {
    const table = operation.detail?.["table"];
    if (operation.type === "delete" && typeof table === "string") {
      perTable.set(table, (perTable.get(table) ?? 0) + 1);
    }
  }
  const offenders = [...perTable.entries()].filter(([, count]) => count > 1);
  if (offenders.length > 0) {
    throw new Error(
      "planner bug: deletes were not coalesced - " +
        offenders.map(([table, count]) => `${table} x${count}`).join(", ") +
        " (section 8.3, A1 allows one ALTER ... DELETE per table per reconcile)",
    );
  }
}
