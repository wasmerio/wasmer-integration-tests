// Billing: the plan catalog, the subscription group and the invoice
// history. Three kinds, at the granularity a human edits: flip the state,
// add an invoice, change the plan.
//
// The subscription is a *group*: djstripe customer + djstripe subscription
// + the backend-native entitlement ledger (`subscriptions` +
// `subscription_events`), which is what `isPro` and `usageReport` actually
// resolve from - djstripe alone is not enough (proven by the retired
// seeder engine).

import { defaultDiff, type ResourceAdapter, type Scope } from "../adapter";
import {
  id,
  resource,
  type OpResult,
  type Operation,
  type Resource,
} from "../model";
import type { InvoiceSpec, PlanVersionSpec, SubscriptionSpec } from "../specs";
import type { EngineContext } from "../engine/context";
import { simId } from "../expand/billing";
import {
  failed,
  inTransaction,
  namespaceContentType,
  ok,
  userPk,
} from "./common";

/** Declared subscription state -> Stripe status + ledger entitlement. */
const STATE_MAP: Record<
  SubscriptionSpec["state"],
  { stripe: string; entitlement: string; cancelAtPeriodEnd: boolean }
> = {
  active: {
    stripe: "active",
    entitlement: "granted",
    cancelAtPeriodEnd: false,
  },
  past_due: {
    stripe: "past_due",
    entitlement: "grace_period",
    cancelAtPeriodEnd: false,
  },
  canceled: {
    stripe: "canceled",
    entitlement: "ended",
    cancelAtPeriodEnd: true,
  },
  trialing: {
    stripe: "trialing",
    entitlement: "granted",
    cancelAtPeriodEnd: false,
  },
};

export const planVersionAdapter: ResourceAdapter<PlanVersionSpec> = {
  kind: "plan-version",
  lane: "postgres",
  granularity: "resource",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<PlanVersionSpec>[]> {
    const rows = await ctx.withPostgres((client) =>
      client.query<{
        id: string;
        slug: string;
        name: string;
        version: number;
        memory: string | null;
      }>(
        `SELECT pv.id, p.slug, p.name, pv.version,
                (SELECT l.limit_value FROM plan_version_limits l
                   JOIN entitlement_definitions ed ON ed.id = l.entitlement_id AND ed.key = 'memory_time'
                  WHERE l.plan_version_id = pv.id LIMIT 1) AS memory
           FROM plan_versions pv
           JOIN plans p ON p.id = pv.plan_id AND p.deleted_at IS NULL
          WHERE pv.status = 'active' AND pv.retired_at IS NULL
          ORDER BY p.slug, pv.version`,
      ),
    );
    void scope;
    return rows.rows.map((row) => {
      const resourceId = id(
        "plan-version",
        row.slug,
        String(row.version).padStart(4, "0"),
      );
      ctx.identity.bind(resourceId, { planVersionId: row.id });
      const limits = { memoryGbh: Math.round(Number(row.memory ?? 0)) };
      return resource<PlanVersionSpec>({
        id: resourceId,
        spec: { slug: row.slug, version: row.version, name: row.name, limits },
        fingerprintOf: { slug: row.slug, version: row.version, limits },
        // A plan the platform already ships is adopted, never re-created:
        // the catalog is shared state, so it is retained on teardown.
        policy: { prune: "retain" },
      });
    });
  },

  diff(desired, observed) {
    if (desired !== null && observed !== null) {
      // A declaration with no limits of its own adopts the catalog row as
      // it stands; one with limits re-points them.
      if (Object.keys(desired.spec.limits).length === 0) {
        return [];
      }
      return desired.fingerprint === observed.fingerprint
        ? []
        : [
            {
              type: "update",
              id: desired.id,
              kind: desired.kind,
              lane: "postgres",
              desired,
              observed,
            },
          ];
    }
    return defaultDiff("postgres", desired, observed);
  },

  async apply(
    ops: Operation<PlanVersionSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    const results: OpResult[] = [];
    for (const operation of ops) {
      if (operation.type === "delete") {
        results.push(ok(operation.id));
        continue;
      }
      const spec = (operation.desired as Resource<PlanVersionSpec>).spec;
      try {
        await inTransaction(ctx, async (client) => {
          const productId = `prod_sim_${spec.slug}`;
          await client.query(
            `INSERT INTO djstripe_product
               (id, livemode, created, metadata, djstripe_created, djstripe_updated, name, active, stripe_data)
             VALUES ($1, false, NOW(), '{}', NOW(), NOW(), $2, true, $3)
             ON CONFLICT (id) DO UPDATE SET active = true`,
            [
              productId,
              spec.name,
              JSON.stringify({
                id: productId,
                object: "product",
                name: spec.name,
                active: true,
                livemode: false,
              }),
            ],
          );
          const plan = await client.query<{ id: string }>(
            `INSERT INTO plans (id, slug, name, description)
             VALUES (gen_random_uuid(), $1, initcap($1), 'Simulated plan')
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [spec.slug],
          );
          const planId =
            plan.rows[0]?.id ??
            (
              await client.query<{ id: string }>(
                `SELECT id FROM plans WHERE slug = $1 AND deleted_at IS NULL`,
                [spec.slug],
              )
            ).rows[0].id;
          const existing = await client.query<{ id: string }>(
            `SELECT id FROM plan_versions WHERE plan_id = $1 AND status = 'active' AND retired_at IS NULL
              ORDER BY version DESC LIMIT 1`,
            [planId],
          );
          let versionId = existing.rows[0]?.id;
          if (versionId === undefined) {
            const inserted = await client.query<{ id: string }>(
              `INSERT INTO plan_versions
                 (id, plan_id, version, status, threshold_policy, is_active_for_new_subscriptions)
               VALUES (gen_random_uuid(), $1, $2, 'active', 'overage', true)
               RETURNING id`,
              [planId, spec.version],
            );
            versionId = inserted.rows[0].id;
            await client.query(
              `INSERT INTO plan_version_stripe_products
                 (id, plan_version_id, entitlement_id, stripe_product_id,
                  required_for_subscription, reports_usage, is_anchor)
               VALUES (gen_random_uuid(), $1, NULL, $2, true, false, true)`,
              [versionId, productId],
            );
          }
          const declaredLimit = spec.limits["memoryGbh"];
          const hasLimits = await client.query<{ count: string }>(
            `SELECT count(*) AS count FROM plan_version_limits WHERE plan_version_id = $1`,
            [versionId],
          );
          if (
            declaredLimit === undefined &&
            Number(hasLimits.rows[0].count) > 0
          ) {
            // Nothing declared and a catalog already in place: adopt it.
            ctx.identity.bind(operation.id, {
              planVersionId: versionId,
              planId,
            });
            return;
          }
          // Limits are rewritten in place: the declared consumption ratio
          // is what sizes them, and it changes with the telemetry.
          await client.query(
            `DELETE FROM plan_version_limits WHERE plan_version_id = $1`,
            [versionId],
          );
          await client.query(
            `INSERT INTO plan_version_limits (id, plan_version_id, entitlement_id, limit_value)
             SELECT gen_random_uuid(), $1, ed.id,
               CASE ed.key
                 WHEN 'memory_time' THEN $2::numeric
                 WHEN 'requests' THEN 10000000
                 WHEN 'active_app_count' THEN 500
                 WHEN 'cpu_time' THEN 10000
                 WHEN 'build_minutes' THEN 10000
                 WHEN 'member_count' THEN 100
                 WHEN 'domain_count' THEN 1000
                 WHEN 'email_sent' THEN 100000
                 ELSE 1000000000000
               END
             FROM entitlement_definitions ed WHERE ed.retired_at IS NULL`,
            [versionId, declaredLimit ?? 1000],
          );
          ctx.identity.bind(operation.id, { planVersionId: versionId, planId });
        });
        results.push(ok(operation.id, { planVersions: 1 }));
      } catch (err) {
        results.push(failed(operation.id, err));
      }
    }
    return results;
  },
};

export const subscriptionAdapter: ResourceAdapter<SubscriptionSpec> = {
  kind: "subscription",
  lane: "postgres",
  granularity: "group",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<SubscriptionSpec>[]> {
    const namespaceId = id("namespace", scope.namespace);
    if (!ctx.identity.has(namespaceId)) {
      return [];
    }
    const contentType = await namespaceContentType(ctx);
    const rows = await ctx.withPostgres((client) =>
      client.query<{
        id: string;
        stripe_customer_id: string;
        stripe_subscription_id: string;
        slug: string | null;
        new_stripe_status: string | null;
        current_period_start: Date | null;
        current_period_end: Date | null;
      }>(
        `SELECT s.id, s.stripe_customer_id, s.stripe_subscription_id, p.slug,
                e.new_stripe_status, e.current_period_start, e.current_period_end
           FROM subscriptions s
           LEFT JOIN LATERAL (
             SELECT * FROM subscription_events se
              WHERE se.subscription_id = s.id ORDER BY se.created_at DESC LIMIT 1
           ) e ON true
           LEFT JOIN plan_versions pv ON pv.id = e.new_plan_version_id
           LEFT JOIN plans p ON p.id = pv.plan_id
           JOIN djstripe_customer c ON c.id = s.stripe_customer_id
          WHERE s.owner_content_type_id = $1 AND s.owner_object_id = $2 AND s.deleted_at IS NULL
            AND s.stripe_customer_id LIKE 'cus_sim_%'
            AND c.metadata -> 'sim' ->> 'scenario' = $3`,
        [
          contentType,
          ctx.identity.requireNumber(namespaceId, "pk"),
          scope.scenario,
        ],
      ),
    );
    return rows.rows.map((row) => {
      const resourceId = id("subscription", scope.namespace);
      ctx.identity.bind(resourceId, {
        ledgerId: row.id,
        customerId: row.stripe_customer_id,
        subscriptionId: row.stripe_subscription_id,
      });
      const state = (Object.entries(STATE_MAP).find(
        ([, mapped]) => mapped.stripe === row.new_stripe_status,
      )?.[0] ?? "active") as SubscriptionSpec["state"];
      return resource<SubscriptionSpec>({
        id: resourceId,
        spec: {
          namespace: scope.namespace,
          plan: row.slug ?? "",
          state,
          periodStartSec: Math.floor(
            (row.current_period_start?.getTime() ?? 0) / 1000,
          ),
          periodEndSec: Math.floor(
            (row.current_period_end?.getTime() ?? 0) / 1000,
          ),
          computeConsumed: 0,
        },
        fingerprintOf: { plan: row.slug ?? "", state },
      });
    });
  },

  diff(desired, observed) {
    return defaultDiff("postgres", desired, observed);
  },

  async apply(
    ops: Operation<SubscriptionSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    const results: OpResult[] = [];
    const contentType = await namespaceContentType(ctx);
    for (const operation of ops) {
      try {
        const namespace =
          (operation.desired?.spec ?? operation.observed?.spec)?.namespace ??
          ctx.scenario;
        const namespacePk = ctx.identity.requireNumber(
          id("namespace", namespace),
          "pk",
        );
        if (operation.type === "delete" || operation.type === "update") {
          await dropSubscription(ctx, namespacePk, contentType, operation.id);
          if (operation.type === "delete") {
            results.push(ok(operation.id));
            continue;
          }
        }
        const spec = (operation.desired as Resource<SubscriptionSpec>).spec;
        const state = STATE_MAP[spec.state];
        const customerId = simId(hashSeed(ctx), `${namespace}/customer`, "cus");
        const subscriptionId = simId(
          hashSeed(ctx),
          `${namespace}/subscription`,
          "sub",
        );
        const ownerUserPk =
          (await userPk(ctx, ctx.credentials.username)) ?? null;
        const price = 1900 + (hashSeed(ctx) % 9) * 1000;
        await inTransaction(ctx, async (client) => {
          const customer = await client.query<{ djstripe_id: number }>(
            `INSERT INTO djstripe_customer
               (id, livemode, created, metadata, email, djstripe_created, djstripe_updated,
                stripe_data, subscriber_id)
             VALUES ($1, false, NOW(), $5, $2, NOW(), NOW(), $3, $4)
             ON CONFLICT (id) DO UPDATE SET djstripe_updated = NOW()
             RETURNING djstripe_id`,
            [
              customerId,
              `${ctx.credentials.username}@simulated.local`,
              JSON.stringify({
                id: customerId,
                object: "customer",
                email: `${ctx.credentials.username}@simulated.local`,
                livemode: false,
              }),
              ownerUserPk,
              JSON.stringify({
                sim: { managed: true, scenario: ctx.scenario },
              }),
            ],
          );
          await client.query(
            `UPDATE registry_namespace SET _stripe_customer_id = $1 WHERE id = $2`,
            [customer.rows[0].djstripe_id, namespacePk],
          );
          const subscriptionData = {
            id: subscriptionId,
            object: "subscription",
            status: state.stripe,
            customer: customerId,
            cancel_at_period_end: state.cancelAtPeriodEnd,
            current_period_start: spec.periodStartSec,
            current_period_end: spec.periodEndSec,
            created: spec.periodStartSec,
            livemode: false,
            ...(spec.state === "trialing"
              ? { trial_end: spec.periodEndSec }
              : {}),
            items: {
              object: "list",
              data: [
                {
                  id: simId(hashSeed(ctx), `${namespace}/item`, "si"),
                  object: "subscription_item",
                  price: {
                    id: `price_sim_${spec.plan}`,
                    object: "price",
                    product: `prod_sim_${spec.plan}`,
                    unit_amount: price,
                    currency: "usd",
                    recurring: { interval: "month" },
                  },
                  quantity: 1,
                },
              ],
            },
          };
          await client.query(
            `INSERT INTO djstripe_subscription
               (id, livemode, created, metadata, djstripe_created, djstripe_updated,
                customer_id, stripe_data)
             VALUES ($1, false, to_timestamp($2), $5, NOW(), NOW(), $3, $4)
             ON CONFLICT (id) DO UPDATE SET stripe_data = EXCLUDED.stripe_data`,
            [
              subscriptionId,
              spec.periodStartSec,
              customerId,
              JSON.stringify(subscriptionData),
              JSON.stringify({
                sim: { managed: true, scenario: ctx.scenario },
              }),
            ],
          );
          const planVersion = await client.query<{
            id: string;
            plan_id: string;
          }>(
            `SELECT pv.id, pv.plan_id FROM plan_versions pv
               JOIN plans p ON p.id = pv.plan_id
              WHERE p.slug = $1 AND pv.status = 'active' AND pv.retired_at IS NULL
              ORDER BY pv.version DESC LIMIT 1`,
            [spec.plan],
          );
          if (planVersion.rows.length === 0) {
            throw new Error(
              `no active plan version for "${spec.plan}" - the plan-version resource must apply first`,
            );
          }
          const ledger = await client.query<{ id: string }>(
            `INSERT INTO subscriptions
               (id, owner_content_type_id, owner_object_id, stripe_customer_id,
                stripe_subscription_id, fallback_plan_id)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
             RETURNING id`,
            [
              contentType,
              namespacePk,
              customerId,
              subscriptionId,
              planVersion.rows[0].plan_id,
            ],
          );
          await client.query(
            `INSERT INTO subscription_events
               (id, subscription_id, owner_content_type_id, owner_object_id, event_kind,
                new_plan_version_id, new_stripe_status, entitlement_status,
                current_period_start, current_period_end, cancel_at_period_end, created_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'created', $4, $5, $6,
                     to_timestamp($7), to_timestamp($8), $9, to_timestamp($7))`,
            [
              ledger.rows[0].id,
              contentType,
              namespacePk,
              planVersion.rows[0].id,
              state.stripe,
              state.entitlement,
              spec.periodStartSec,
              spec.periodEndSec,
              state.cancelAtPeriodEnd,
            ],
          );
          ctx.identity.bind(operation.id, {
            ledgerId: ledger.rows[0].id,
            customerId,
            subscriptionId,
          });
        });
        results.push(ok(operation.id, { subscriptions: 1 }));
      } catch (err) {
        results.push(failed(operation.id, err));
      }
    }
    return results;
  },
};

/** Deterministic per-platform salt for synthetic Stripe ids. The engine has
 * no seed, so the scenario slug stands in - ids stay stable across
 * reconciles of the same world, which is what keeps them adoptable. */
function hashSeed(ctx: EngineContext): number {
  let hash = 2166136261;
  for (const character of ctx.scenario) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return hash;
}

async function dropSubscription(
  ctx: EngineContext,
  namespacePk: number,
  contentType: number,
  subscriptionResource: import("../model").ResourceId,
): Promise<void> {
  // Keyed on the recorded ids, never on `LIKE 'cus_sim_%'`: another
  // scenario's customer is another scenario's business, and a wildcard
  // delete here would take it with us.
  const native = ctx.identity.native(subscriptionResource);
  const customerId = native?.["customerId"];
  const subscriptionId = native?.["subscriptionId"];
  if (customerId === undefined) {
    return;
  }
  await inTransaction(ctx, async (client) => {
    await client.query(
      `UPDATE registry_namespace SET _stripe_customer_id = NULL
        WHERE _stripe_customer_id IN (SELECT djstripe_id FROM djstripe_customer WHERE id = $1)`,
      [String(customerId)],
    );
    await client.query(
      `DELETE FROM subscription_events WHERE owner_content_type_id = $1 AND owner_object_id = $2`,
      [contentType, namespacePk],
    );
    await client.query(
      `DELETE FROM subscriptions WHERE owner_content_type_id = $1 AND owner_object_id = $2
         AND stripe_customer_id = $3`,
      [contentType, namespacePk, String(customerId)],
    );
    await client.query(`DELETE FROM djstripe_invoice WHERE customer_id = $1`, [
      String(customerId),
    ]);
    if (subscriptionId !== undefined) {
      await client.query(`DELETE FROM djstripe_subscription WHERE id = $1`, [
        String(subscriptionId),
      ]);
    }
    await client.query(
      `DELETE FROM djstripe_subscription WHERE customer_id = $1`,
      [String(customerId)],
    );
    await client.query(`DELETE FROM djstripe_customer WHERE id = $1`, [
      String(customerId),
    ]);
  });
}

export const invoiceAdapter: ResourceAdapter<InvoiceSpec> = {
  kind: "invoice",
  lane: "postgres",
  granularity: "group",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<InvoiceSpec>[]> {
    const rows = await ctx.withPostgres((client) =>
      client.query<{
        id: string;
        number: string;
        status: string;
        amount: string;
        created: Date;
      }>(
        // Marker-scoped like every other owned row: another scenario's
        // invoices (or unmarked pre-reconciler rows) are not this
        // reconcile's business.
        `SELECT id,
                stripe_data ->> 'number' AS number,
                stripe_data ->> 'status' AS status,
                stripe_data ->> 'amount_due' AS amount,
                created
           FROM djstripe_invoice
          WHERE id LIKE 'in_sim_%' AND metadata -> 'sim' ->> 'scenario' = $1
          ORDER BY stripe_data ->> 'number'`,
        [scope.scenario],
      ),
    );
    return rows.rows
      .filter((row) => row.number !== null)
      .map((row) => {
        const resourceId = id("invoice", scope.namespace, row.number);
        ctx.identity.bind(resourceId, { stripeId: row.id });
        const status = (
          row.status === "paid"
            ? "paid"
            : row.status === "open"
              ? "open"
              : "uncollectible"
        ) as InvoiceSpec["status"];
        return resource<InvoiceSpec>({
          id: resourceId,
          spec: {
            namespace: scope.namespace,
            number: row.number,
            amountCents: Number(row.amount),
            status,
            createdSec: Math.floor(row.created.getTime() / 1000),
          },
          fingerprintOf: {
            number: row.number,
            amountCents: Number(row.amount),
            status,
          },
        });
      });
  },

  diff(desired, observed) {
    return defaultDiff("postgres", desired, observed);
  },

  async apply(
    ops: Operation<InvoiceSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    const deletes = ops.filter(
      (operation) => operation.type === "delete" || operation.type === "update",
    );
    const writes = ops.filter((operation) => operation.type !== "delete");
    try {
      await inTransaction(ctx, async (client) => {
        if (deletes.length > 0) {
          const ids = deletes.map((operation) =>
            ctx.identity.requireString(operation.id, "stripeId"),
          );
          await client.query(
            `DELETE FROM djstripe_invoice WHERE id = ANY($1::text[])`,
            [ids],
          );
        }
        for (const operation of writes) {
          const spec = (operation.desired as Resource<InvoiceSpec>).spec;
          const subscriptionId = ctx.identity.requireString(
            id("subscription", spec.namespace),
            "subscriptionId",
          );
          const customerId = ctx.identity.requireString(
            id("subscription", spec.namespace),
            "customerId",
          );
          const invoiceId = simId(
            hashSeed(ctx),
            `${spec.namespace}/invoice/${spec.number}`,
            "in",
          );
          const data = {
            id: invoiceId,
            object: "invoice",
            number: spec.number,
            status: spec.status,
            amount_due: spec.amountCents,
            amount_paid: spec.status === "paid" ? spec.amountCents : 0,
            currency: "usd",
            created: spec.createdSec,
            customer: customerId,
            subscription: subscriptionId,
            hosted_invoice_url: `https://invoice.simulated.local/${invoiceId}`,
            invoice_pdf: `https://invoice.simulated.local/${invoiceId}.pdf`,
            livemode: false,
          };
          // The resolver reads the `created` *column* for invoice dates, so
          // it is backdated alongside stripe_data.
          await client.query(
            `INSERT INTO djstripe_invoice
               (id, livemode, created, metadata, djstripe_created, djstripe_updated,
                customer_id, subscription_id, stripe_data)
             VALUES ($1, false, to_timestamp($2), $6, NOW(), NOW(), $3, $4, $5)
             ON CONFLICT (id) DO UPDATE SET stripe_data = EXCLUDED.stripe_data,
                                            created = EXCLUDED.created`,
            [
              invoiceId,
              spec.createdSec,
              customerId,
              subscriptionId,
              JSON.stringify(data),
              JSON.stringify({
                sim: { managed: true, scenario: ctx.scenario },
              }),
            ],
          );
          ctx.identity.bind(operation.id, { stripeId: invoiceId });
        }
      });
      return ops.map((operation, index) =>
        ok(operation.id, index === 0 ? { invoices: writes.length } : undefined),
      );
    } catch (err) {
      return ops.map((operation) => failed(operation.id, err));
    }
  },
};
