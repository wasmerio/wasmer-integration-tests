// Billing expansion: plan catalog, the subscription group (djstripe
// customer + subscription + the backend-native entitlement ledger) and the
// invoice history. Three kinds, because that is the granularity a human
// edits: flip the state, add an invoice, change the plan.

import { createHash } from "node:crypto";
import { id, resource, type Resource } from "../model";
import type { InvoiceSpec, PlanVersionSpec, SubscriptionSpec } from "../specs";
import type { World } from "./world";

const DAY_SEC = 86_400;

/** Seed-stable synthetic store id: same seed and label give the same id
 * forever, and adding an invoice never shifts the customer's id. */
export function simId(seed: number, label: string, prefix: string): string {
  const hash = createHash("sha1").update(`${seed}:${label}`).digest("hex");
  return `${prefix}_sim_${hash.slice(0, 14)}`;
}

export function billingPeriod(world: World): {
  startSec: number;
  endSec: number;
} {
  const anchorSec = world.anchorSec;
  return {
    startSec: anchorSec - 10 * DAY_SEC,
    endSec: anchorSec + 20 * DAY_SEC,
  };
}

/** Memory GB-hours the declared telemetry puts inside the billing period -
 * what `entitlements.computeConsumed` sizes the plan limit against, so the
 * usage ring shows the declared fraction. */
export function memoryGbhInPeriod(world: World): number {
  const traffic = world.traffic;
  if (traffic === null) {
    return 0;
  }
  const { startSec } = billingPeriod(world);
  let kbs = 0;
  traffic.workloadHours.forEach((hour) => {
    if (hour.start >= startSec) {
      kbs += hour.perApp.reduce((sum, app) => sum + app.memoryTimeKbs, 0);
    }
  });
  return kbs / (1024 * 1024) / 3600;
}

export function* expandBilling(world: World): Generator<Resource> {
  const billing = world.declaration.billing;
  if (billing === undefined) {
    return;
  }
  // A scenario only has an opinion about plan limits when it declares the
  // consumption ratio it wants the usage ring to show. Without one it
  // adopts the catalog as it stands - otherwise two scenarios sharing a
  // plan slug would each rewrite the other's limits on every reconcile.
  const consumed = billing.entitlements?.computeConsumed;
  const inPeriod = memoryGbhInPeriod(world);
  const limits =
    consumed !== undefined && consumed > 0 && inPeriod > 0
      ? { memoryGbh: Math.max(1, Math.round(inPeriod / consumed)) }
      : {};

  yield resource<PlanVersionSpec>({
    id: id("plan-version", billing.plan, "0001"),
    spec: {
      slug: billing.plan,
      version: 1,
      name: billing.plan,
      limits,
    },
    // The catalog is shared platform state: it is adopted by slug and
    // retained on teardown, and its display name is not ours to declare.
    policy: { prune: "retain" },
    fingerprintOf: { slug: billing.plan, version: 1, limits },
  });

  const { startSec, endSec } = billingPeriod(world);
  yield resource<SubscriptionSpec>({
    id: id("subscription", world.namespace),
    spec: {
      namespace: world.namespace,
      plan: billing.plan,
      state: billing.subscription,
      periodStartSec: startSec,
      periodEndSec: endSec,
      computeConsumed: consumed ?? 0,
    },
    deps: [
      id("namespace", world.namespace),
      id("plan-version", billing.plan, "0001"),
    ],
    // The period slides with the anchor; only the declared state and plan
    // make a subscription different.
    fingerprintOf: { plan: billing.plan, state: billing.subscription },
  });

  const price = 1900 + (world.seed % 9) * 1000;
  // Emitted in natural-key order (SIM-0001 first): the planner merge-joins
  // two sorted streams, so an expander that yields newest-first would look
  // like a world full of creates and deletes.
  for (let position = 0; position < billing.invoices.count; position++) {
    const index = billing.invoices.count - 1 - position;
    const number = `SIM-${String(position + 1).padStart(4, "0")}`;
    const failed = index < billing.invoices.failed;
    yield resource<InvoiceSpec>({
      id: id("invoice", world.namespace, number),
      spec: {
        namespace: world.namespace,
        number,
        amountCents: price,
        status: failed ? "open" : "paid",
        createdSec: world.anchorSec - index * 30 * DAY_SEC,
      },
      deps: [id("subscription", world.namespace)],
      fingerprintOf: {
        number,
        amountCents: price,
        status: failed ? "open" : "paid",
      },
    });
  }
}
