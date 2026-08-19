// Billing writer (spec §3.3, D-C, empirically mapped 2026-08-14). The
// backend renders billing from three cooperating stores, all Postgres:
//   1. djstripe_* jsonb mirrors — BillingContent's subscriptions +
//      invoiceConnection read djstripe_subscription/djstripe_invoice
//      `stripe_data` (invoice dates read the `created` *column*, so history
//      must backdate it), linked through djstripe_customer and
//      registry_namespace._stripe_customer_id.
//   2. The plan catalog — plans/plan_versions/plan_version_limits/
//      plan_version_stripe_products (empty on a fresh local platform).
//   3. The backend-native subscription ledger — subscriptions +
//      subscription_events; the latest event drives `isPro` and the
//      usageReport window/plan (verified live: without it usageReport is
//      null, with it the full metric list renders).
// stripe-mock stays a stateless call sink (D-C): nothing here reads or
// writes it; cancel/renew/checkout wiring works only when it is up, which
// is warned about, not required.

import type { Client } from "pg";
import {
  assertTableColumns,
  connectSimulatorPostgres,
} from "../clients/postgres";
import type { SimulatorDeclaration, BillingBlock } from "../schema";
import { type EmitEntry, type SeedContext, type Seeder } from "../registry";
import type { Random } from "../random";

/** D-B assertion set (Postgres flavor) for every table this seeder writes. */
export const BILLING_TABLES: Record<string, Record<string, string>> = {
  djstripe_customer: {
    djstripe_id: "bigint",
    id: "character varying",
    livemode: "boolean",
    created: "timestamp with time zone",
    metadata: "jsonb",
    email: "text",
    djstripe_created: "timestamp with time zone",
    djstripe_updated: "timestamp with time zone",
    stripe_data: "jsonb",
    subscriber_id: "integer",
  },
  djstripe_subscription: {
    djstripe_id: "bigint",
    id: "character varying",
    customer_id: "character varying",
    stripe_data: "jsonb",
    created: "timestamp with time zone",
  },
  djstripe_invoice: {
    djstripe_id: "bigint",
    id: "character varying",
    customer_id: "character varying",
    subscription_id: "character varying",
    stripe_data: "jsonb",
    created: "timestamp with time zone",
  },
  djstripe_product: {
    djstripe_id: "bigint",
    id: "character varying",
    name: "text",
    active: "boolean",
    stripe_data: "jsonb",
  },
  plans: { id: "uuid", slug: "text", name: "text" },
  plan_versions: {
    id: "uuid",
    plan_id: "uuid",
    version: "integer",
    status: "text",
    threshold_policy: "text",
    is_active_for_new_subscriptions: "boolean",
  },
  plan_version_limits: {
    id: "uuid",
    plan_version_id: "uuid",
    entitlement_id: "uuid",
    limit_value: "numeric",
  },
  plan_version_stripe_products: {
    id: "uuid",
    plan_version_id: "uuid",
    stripe_product_id: "text",
    required_for_subscription: "boolean",
    is_anchor: "boolean",
  },
  subscriptions: {
    id: "uuid",
    owner_content_type_id: "integer",
    owner_object_id: "integer",
    stripe_customer_id: "text",
    stripe_subscription_id: "text",
    fallback_plan_id: "uuid",
  },
  subscription_events: {
    id: "uuid",
    subscription_id: "uuid",
    owner_content_type_id: "integer",
    owner_object_id: "integer",
    event_kind: "text",
    new_plan_version_id: "uuid",
    new_stripe_status: "text",
    entitlement_status: "text",
    current_period_start: "timestamp with time zone",
    current_period_end: "timestamp with time zone",
    cancel_at_period_end: "boolean",
  },
};

export interface DjstripeRowsEntry {
  kind: "djstripe-rows";
  /** Human-readable anchor (spec §2.2 sketch). */
  customerId: string;
  /** Namespace whose _stripe_customer_id link must be cleared. */
  namespacePk: number;
  /** table -> recorded PKs (stringified; each table's PK column is known
   * to the teardown kind). */
  tables: Record<string, string[]>;
}

/** Declared subscription state → Stripe status + ledger entitlement. */
const STATE_MAP: Record<
  BillingBlock["subscription"],
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

function simUuid(random: Random): string {
  const hex = "0123456789abcdef";
  const draw = (count: number): string =>
    Array.from({ length: count }, () => hex[random.int(0, 15)]).join("");
  return `${draw(8)}-${draw(4)}-4${draw(3)}-8${draw(3)}-${draw(12)}`;
}

function simStripeId(random: Random, prefix: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const suffix = Array.from(
    { length: 14 },
    () => alphabet[random.int(0, alphabet.length - 1)],
  ).join("");
  return `${prefix}_sim_${suffix}`;
}

export const billingSeeder: Seeder = {
  block: "billing",

  plan(declaration: SimulatorDeclaration): string[] {
    const billing = declaration.billing;
    if (billing === undefined) {
      return [];
    }
    return [
      `billing: plan "${billing.plan}", subscription ${billing.subscription}, ` +
        `${billing.invoices.count} invoices (${billing.invoices.failed} failed)` +
        (billing.entitlements !== undefined
          ? `, compute ${Math.round(billing.entitlements.computeConsumed * 100)}% consumed`
          : ""),
      "  writes: djstripe customer/subscription/invoices + plan catalog + " +
        "subscription ledger (usageReport/isPro)",
    ];
  },

  async apply(
    declaration: SimulatorDeclaration,
    ctx: SeedContext,
    emit: EmitEntry,
  ): Promise<void> {
    const billing = declaration.billing;
    if (billing === undefined) {
      return;
    }
    const namespacePk = ctx.ids.namespacePk;
    const userPk = ctx.ids.userPk;
    if (namespacePk === undefined || userPk === undefined) {
      throw new Error(
        "billing seeder ran before the account seeder (§3.1 order)",
      );
    }
    if ((ctx.env["STRIPE_MOCK_URL"] ?? "") === "") {
      ctx.io.err(
        "warning: STRIPE_MOCK_URL is not exported — billing state will " +
          "render, but cancel/renew/checkout mutations will error in the " +
          "UI (stripe-mock is off; D-C wiring-only either way)",
      );
    }

    const postgres = await connectSimulatorPostgres(ctx.env);
    try {
      for (const [table, columns] of Object.entries(BILLING_TABLES)) {
        await assertTableColumns(postgres, table, columns);
      }
      const contentType = await postgres.query<{ id: number }>(
        `SELECT id FROM django_content_type
         WHERE app_label = 'registry' AND model = 'namespace'`,
      );
      if (contentType.rows.length !== 1) {
        throw new Error("cannot resolve the registry.namespace content type");
      }
      const namespaceContentType = contentType.rows[0].id;

      const random = ctx.random.fork("billing");
      const customerId = simStripeId(random, "cus");
      const subscriptionId = simStripeId(random, "sub");
      const productId = `prod_sim_${billing.plan}`;
      const state = STATE_MAP[billing.subscription];
      const nowMs = Date.now();
      const dayMs = 86_400_000;
      const periodStart = new Date(nowMs - 10 * dayMs);
      const periodEnd = new Date(nowMs + 20 * dayMs);
      const trialEnd = billing.subscription === "trialing" ? periodEnd : null;
      const price = 1900 + random.int(0, 8) * 1000;

      const created: Record<string, string[]> = {};
      const record = (table: string, pk: string | number): void => {
        (created[table] ??= []).push(String(pk));
      };

      // `entitlements.computeConsumed` sizes the memory limit so the usage
      // ring shows the declared consumption. `used` sums only the billing
      // period, so the limit derives from the telemetry model's days that
      // fall inside it (set by the telemetry seeder).
      const consumed = billing.entitlements?.computeConsumed;
      const periodStartDate = new Date(nowMs - 10 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const memoryGbhInPeriod = ctx.ids.telemetryTotals?.daily
        .filter((day) => day.date >= periodStartDate)
        .reduce((sum, day) => sum + day.memoryGbh, 0);
      const memoryLimit =
        consumed !== undefined &&
        consumed > 0 &&
        memoryGbhInPeriod !== undefined &&
        memoryGbhInPeriod > 0
          ? Math.max(1, Math.round(memoryGbhInPeriod / consumed))
          : 1000;

      await postgres.query("BEGIN");
      try {
        const customer = await postgres.query<{ djstripe_id: number }>(
          `INSERT INTO djstripe_customer
             (id, livemode, created, metadata, email, djstripe_created,
              djstripe_updated, stripe_data, subscriber_id)
           VALUES ($1, false, NOW(), '{}', $2, NOW(), NOW(), $3, $4)
           RETURNING djstripe_id`,
          [
            customerId,
            `${declaration.account.username}@simulated.local`,
            JSON.stringify({
              id: customerId,
              object: "customer",
              email: `${declaration.account.username}@simulated.local`,
              livemode: false,
            }),
            userPk,
          ],
        );
        record("djstripe_customer", customer.rows[0].djstripe_id);
        await postgres.query(
          `UPDATE registry_namespace SET _stripe_customer_id = $1 WHERE id = $2`,
          [customer.rows[0].djstripe_id, namespacePk],
        );

        const product = await postgres.query<{ djstripe_id: number }>(
          `INSERT INTO djstripe_product
             (id, livemode, created, metadata, djstripe_created,
              djstripe_updated, name, active, stripe_data)
           VALUES ($1, false, NOW(), '{}', NOW(), NOW(), $2, true, $3)
           ON CONFLICT (id) DO UPDATE SET active = true
           RETURNING djstripe_id`,
          [
            productId,
            billing.plan,
            JSON.stringify({
              id: productId,
              object: "product",
              name: billing.plan,
              active: true,
              livemode: false,
            }),
          ],
        );
        record("djstripe_product", product.rows[0].djstripe_id);

        // Plan catalog: adopt an existing slug, else create (recorded only
        // when created, so teardown removes exactly what this seed added).
        const planId = await ensurePlan(postgres, billing.plan, random, record);
        const planVersionId = await ensurePlanVersion(
          postgres,
          planId,
          productId,
          memoryLimit,
          random,
          record,
        );

        const subscriptionData = {
          id: subscriptionId,
          object: "subscription",
          status: state.stripe,
          customer: customerId,
          cancel_at_period_end: state.cancelAtPeriodEnd,
          current_period_start: Math.floor(periodStart.getTime() / 1000),
          current_period_end: Math.floor(periodEnd.getTime() / 1000),
          created: Math.floor(periodStart.getTime() / 1000),
          livemode: false,
          ...(trialEnd !== null
            ? { trial_end: Math.floor(trialEnd.getTime() / 1000) }
            : {}),
          items: {
            object: "list",
            data: [
              {
                id: simStripeId(random, "si"),
                object: "subscription_item",
                price: {
                  id: `price_sim_${billing.plan}`,
                  object: "price",
                  product: productId,
                  unit_amount: price,
                  currency: "usd",
                  recurring: { interval: "month" },
                },
                quantity: 1,
              },
            ],
          },
        };
        const subscription = await postgres.query<{ djstripe_id: number }>(
          `INSERT INTO djstripe_subscription
             (id, livemode, created, metadata, djstripe_created,
              djstripe_updated, customer_id, stripe_data)
           VALUES ($1, false, $2, '{}', NOW(), NOW(), $3, $4)
           RETURNING djstripe_id`,
          [
            subscriptionId,
            periodStart,
            customerId,
            JSON.stringify(subscriptionData),
          ],
        );
        record("djstripe_subscription", subscription.rows[0].djstripe_id);

        // Invoice history, newest first: one per month back from now; the
        // declared failures are the most recent ones (how a past_due
        // account actually looks). The resolver reads the `created`
        // *column* for dates, so it is backdated alongside stripe_data.
        for (let index = 0; index < billing.invoices.count; index++) {
          const invoiceId = simStripeId(random, "in");
          const createdAt = new Date(nowMs - index * 30 * dayMs);
          const failed = index < billing.invoices.failed;
          const invoiceData = {
            id: invoiceId,
            object: "invoice",
            number: `SIM-${String(billing.invoices.count - index).padStart(4, "0")}`,
            status: failed ? "open" : "paid",
            amount_due: price,
            amount_paid: failed ? 0 : price,
            currency: "usd",
            created: Math.floor(createdAt.getTime() / 1000),
            customer: customerId,
            subscription: subscriptionId,
            hosted_invoice_url: `https://invoice.simulated.local/${invoiceId}`,
            invoice_pdf: `https://invoice.simulated.local/${invoiceId}.pdf`,
            livemode: false,
          };
          const invoice = await postgres.query<{ djstripe_id: number }>(
            `INSERT INTO djstripe_invoice
               (id, livemode, created, metadata, djstripe_created,
                djstripe_updated, customer_id, subscription_id, stripe_data)
             VALUES ($1, false, $2, '{}', NOW(), NOW(), $3, $4, $5)
             RETURNING djstripe_id`,
            [
              invoiceId,
              createdAt,
              customerId,
              subscriptionId,
              JSON.stringify(invoiceData),
            ],
          );
          record("djstripe_invoice", invoice.rows[0].djstripe_id);
        }

        // The backend-native ledger: the latest event is what isPro and
        // usageReport resolve from.
        const ledgerSubscription = simUuid(random);
        await postgres.query(
          `INSERT INTO subscriptions
             (id, owner_content_type_id, owner_object_id, stripe_customer_id,
              stripe_subscription_id, fallback_plan_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            ledgerSubscription,
            namespaceContentType,
            namespacePk,
            customerId,
            subscriptionId,
            planId,
          ],
        );
        record("subscriptions", ledgerSubscription);
        const eventId = simUuid(random);
        await postgres.query(
          `INSERT INTO subscription_events
             (id, subscription_id, owner_content_type_id, owner_object_id,
              event_kind, new_plan_version_id, new_stripe_status,
              entitlement_status, current_period_start, current_period_end,
              cancel_at_period_end, created_at)
           VALUES ($1, $2, $3, $4, 'created', $5, $6, $7, $8, $9, $10, $8)`,
          [
            eventId,
            ledgerSubscription,
            namespaceContentType,
            namespacePk,
            planVersionId,
            state.stripe,
            state.entitlement,
            periodStart,
            periodEnd,
            state.cancelAtPeriodEnd,
          ],
        );
        record("subscription_events", eventId);

        await postgres.query("COMMIT");
      } catch (err) {
        await postgres.query("ROLLBACK").catch(() => undefined);
        throw err;
      }

      emit({
        kind: "djstripe-rows",
        customerId,
        namespacePk,
        tables: created,
      } satisfies DjstripeRowsEntry);
      ctx.io.err(
        `billing: ${billing.subscription} "${billing.plan}" subscription, ` +
          `${billing.invoices.count} invoices, ledger + plan catalog written`,
      );
    } finally {
      await postgres.end().catch(() => undefined);
    }
  },
};

async function ensurePlan(
  postgres: Client,
  slug: string,
  random: Random,
  record: (table: string, pk: string | number) => void,
): Promise<string> {
  const existing = await postgres.query<{ id: string }>(
    "SELECT id FROM plans WHERE slug = $1 AND deleted_at IS NULL",
    [slug],
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }
  const planId = simUuid(random);
  await postgres.query(
    `INSERT INTO plans (id, slug, name, description)
     VALUES ($1, $2, initcap($2), 'Simulated plan')`,
    [planId, slug],
  );
  record("plans", planId);
  return planId;
}

async function ensurePlanVersion(
  postgres: Client,
  planId: string,
  productId: string,
  memoryLimitGbh: number,
  random: Random,
  record: (table: string, pk: string | number) => void,
): Promise<string> {
  const existing = await postgres.query<{ id: string }>(
    `SELECT id FROM plan_versions
     WHERE plan_id = $1 AND status = 'active' AND retired_at IS NULL
     ORDER BY version DESC LIMIT 1`,
    [planId],
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }
  const versionId = simUuid(random);
  await postgres.query(
    `INSERT INTO plan_versions
       (id, plan_id, version, status, threshold_policy,
        is_active_for_new_subscriptions)
     VALUES ($1, $2, 1, 'active', 'overage', true)`,
    [versionId, planId],
  );
  record("plan_versions", versionId);
  const mapping = simUuid(random);
  await postgres.query(
    `INSERT INTO plan_version_stripe_products
       (id, plan_version_id, entitlement_id, stripe_product_id,
        required_for_subscription, reports_usage, is_anchor)
     VALUES ($1, $2, NULL, $3, true, false, true)`,
    [mapping, versionId, productId],
  );
  record("plan_version_stripe_products", mapping);
  const limits = await postgres.query<{ id: string }>(
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
         -- byte-denominated metrics: 1 TB
         ELSE 1000000000000
       END
     FROM entitlement_definitions ed WHERE ed.retired_at IS NULL
     RETURNING id`,
    [versionId, memoryLimitGbh],
  );
  for (const row of limits.rows) {
    record("plan_version_limits", row.id);
  }
  return versionId;
}
