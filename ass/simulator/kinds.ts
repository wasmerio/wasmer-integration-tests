// Teardown kinds for account/app/portfolio state (worklog "teardown
// correctness model"): every delete keys on concrete recorded IDs, absent
// rows are success, and secrets are re-read from the platform env at down
// time (the descriptor never carries them). The admin token from
// test-env.sh authorizes account/namespace deletion — the scenario user's
// password is deliberately not available here.

import { z } from "zod";
import { SimulatorBackend } from "./clients/graphql";
import { connectSimulatorPostgres } from "./clients/postgres";
import { SimulatorClickHouse } from "./clients/clickhouse";
import { OWNER_KEYED_TABLES } from "./seeders/telemetry";
import type { TeardownContext, TeardownKind } from "./registry";
import type { TeardownEntry } from "./descriptor";

const accountEntrySchema = z.object({
  kind: z.literal("account"),
  username: z.string(),
  namespace: z.string(),
  userId: z.string(),
  namespaceId: z.string().nullable(),
  createdNamespace: z.boolean(),
  // Absent on pre-pinning descriptors: those were full-teardown holds.
  pinned: z.boolean().default(false),
});

const deployedAppEntrySchema = z.object({
  kind: z.literal("deployed-app"),
  namespace: z.string(),
  name: z.string(),
  appId: z.string(),
});

const clickhouseRowsEntrySchema = z.object({
  kind: z.literal("clickhouse-rows"),
  ownerId: z.number().int().positive(),
  appExternalIds: z.array(z.string()),
});

const djstripeRowsEntrySchema = z.object({
  kind: z.literal("djstripe-rows"),
  customerId: z.string(),
  namespacePk: z.number().int().positive(),
  tables: z.record(z.string(), z.array(z.string())),
});

// node-pg returns bigint PKs as strings, so both spellings are recorded.
const postgresRowsEntrySchema = z.object({
  kind: z.literal("postgres-rows"),
  table: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  pks: z.array(z.union([z.number().int(), z.string().regex(/^\d+$/)])),
});

function parseEntry<T>(
  schema: z.ZodType<T>,
  entry: TeardownEntry,
): T | { error: string } {
  const parsed = schema.safeParse(entry);
  if (!parsed.success) {
    return {
      error: `malformed ${entry.kind} entry in descriptor: ${parsed.error.issues
        .map((issue) => issue.message)
        .join(", ")}`,
    };
  }
  return parsed.data;
}

function adminBackend(ctx: TeardownContext): SimulatorBackend | string {
  if (ctx.env === null) {
    return "platform env unavailable for a datastore teardown entry";
  }
  const registry = ctx.env["WASMER_REGISTRY"];
  const token = ctx.env["WASMER_TOKEN"];
  if (registry === undefined || token === undefined) {
    return "test-env.sh exports no WASMER_REGISTRY/WASMER_TOKEN — cannot authorize teardown";
  }
  return new SimulatorBackend(registry, token);
}

/** FK-safe delete order for fabricated portfolio rows: children first. The
 * usage-snapshot table is standalone (telemetry-owned rows). */
const POSTGRES_DELETE_ORDER = [
  "usage_metrics_periodicusagesnapshot",
  "deploy_appvolume",
  "deploy_appalias",
  "deploy_rollout",
  "deploy_deployappversion",
  "deploy_deployapp",
];

export const accountKind: TeardownKind = {
  kind: "account",
  async down(entry, ctx) {
    const parsed = parseEntry(accountEntrySchema, entry);
    if ("error" in parsed) {
      return [parsed.error];
    }
    // The superuser lens: a pinned identity is deliberately kept — the
    // scenario's owned state (apps/telemetry/billing) is torn down by its
    // own entries, and the next seed adopts this same user + namespace, so
    // signed-in browser sessions survive the switch.
    if (parsed.pinned) {
      ctx.io.err(
        `account: "${parsed.username}" + namespace "${parsed.namespace}" ` +
          "kept (pinned)",
      );
      return [];
    }
    const backend = adminBackend(ctx);
    if (typeof backend === "string") {
      return [backend];
    }
    const errors: string[] = [];
    try {
      await backend.deleteUser(parsed.userId);
    } catch (err) {
      errors.push(
        `deleteUser(${parsed.username}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // The deleteNamespace mutation silently no-ops for a non-maintainer
    // (returns null, verified live 2026-08-14), and the owner is gone by
    // now — so mirror the product's soft delete directly, renaming so the
    // name is free for the next seed.
    if (parsed.createdNamespace && parsed.namespaceId !== null) {
      try {
        const postgres = await connectSimulatorPostgres(
          ctx.env as Record<string, string>,
        );
        try {
          await postgres.query(
            `UPDATE registry_namespace
             SET deleted_at = NOW(), name = name || '-simdel-' || id
             WHERE external_id = $1 AND deleted_at IS NULL`,
            [parsed.namespaceId],
          );
        } finally {
          await postgres.end().catch(() => undefined);
        }
      } catch (err) {
        errors.push(
          `soft-delete namespace ${parsed.namespace}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return errors;
  },
};

export const deployedAppKind: TeardownKind = {
  kind: "deployed-app",
  async down(entry, ctx) {
    const parsed = parseEntry(deployedAppEntrySchema, entry);
    if ("error" in parsed) {
      return [parsed.error];
    }
    const backend = adminBackend(ctx);
    if (typeof backend === "string") {
      return [backend];
    }
    try {
      await backend.deleteApp(parsed.appId);
      return [];
    } catch (err) {
      return [
        `deleteApp(${parsed.namespace}/${parsed.name}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      ];
    }
  },
};

/** FK-safe delete order and each table's PK column for the billing set. */
const DJSTRIPE_DELETE_ORDER: Array<{ table: string; pk: string }> = [
  { table: "subscription_events", pk: "id" },
  { table: "subscriptions", pk: "id" },
  { table: "plan_version_limits", pk: "id" },
  { table: "plan_version_stripe_products", pk: "id" },
  { table: "plan_versions", pk: "id" },
  { table: "plans", pk: "id" },
  { table: "djstripe_invoice", pk: "djstripe_id" },
  { table: "djstripe_subscription", pk: "djstripe_id" },
  { table: "djstripe_customer", pk: "djstripe_id" },
  { table: "djstripe_product", pk: "djstripe_id" },
];

export const djstripeRowsKind: TeardownKind = {
  kind: "djstripe-rows",
  async down(entry, ctx) {
    const parsed = parseEntry(djstripeRowsEntrySchema, entry);
    if ("error" in parsed) {
      return [parsed.error];
    }
    if (ctx.env === null) {
      return ["platform env unavailable for a djstripe-rows entry"];
    }
    const errors: string[] = [];
    try {
      const postgres = await connectSimulatorPostgres(ctx.env);
      try {
        // Unlink before the customer row disappears (FK on the namespace).
        await postgres.query(
          `UPDATE registry_namespace SET _stripe_customer_id = NULL
           WHERE id = $1`,
          [parsed.namespacePk],
        );
        for (const { table, pk } of DJSTRIPE_DELETE_ORDER) {
          const pks = parsed.tables[table];
          if (pks === undefined || pks.length === 0) {
            continue;
          }
          try {
            await postgres.query(
              `DELETE FROM ${table} WHERE ${pk}::text = ANY($1::text[])`,
              [pks],
            );
          } catch (err) {
            errors.push(
              `delete from ${table}: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        for (const table of Object.keys(parsed.tables)) {
          if (!DJSTRIPE_DELETE_ORDER.some((known) => known.table === table)) {
            errors.push(
              `djstripe-rows entry names unexpected table "${table}" — ` +
                "refusing a delete outside the recorded billing set",
            );
          }
        }
      } finally {
        await postgres.end().catch(() => undefined);
      }
    } catch (err) {
      errors.push(
        `djstripe teardown: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return errors;
  },
};

export const clickhouseRowsKind: TeardownKind = {
  kind: "clickhouse-rows",
  async down(entry, ctx) {
    const parsed = parseEntry(clickhouseRowsEntrySchema, entry);
    if ("error" in parsed) {
      return [parsed.error];
    }
    if (ctx.env === null) {
      return ["platform env unavailable for a clickhouse-rows entry"];
    }
    const errors: string[] = [];
    try {
      const clickhouse = new SimulatorClickHouse(ctx.env);
      for (const table of OWNER_KEYED_TABLES) {
        errors.push(
          ...(await clickhouse.deleteWhere(
            table,
            `app_owner_id = ${parsed.ownerId} AND app_owner_is_user = false`,
          )),
        );
      }
      // request_log_hourly carries no owner column; it is keyed by the
      // recorded app external_ids instead (only raw-window inserts feed it).
      if (parsed.appExternalIds.length > 0) {
        const ids = parsed.appExternalIds
          .map((id) => `'${id.replaceAll("'", "''")}'`)
          .join(",");
        errors.push(
          ...(await clickhouse.deleteWhere(
            "request_log_hourly",
            `external_id IN (${ids})`,
          )),
        );
      }
    } catch (err) {
      errors.push(
        `clickhouse teardown: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return errors;
  },
};

export const postgresRowsKind: TeardownKind = {
  kind: "postgres-rows",
  async down(entry, ctx) {
    const parsed = parseEntry(postgresRowsEntrySchema, entry);
    if ("error" in parsed) {
      return [parsed.error];
    }
    if (parsed.pks.length === 0) {
      return [];
    }
    if (ctx.env === null) {
      return ["platform env unavailable for a postgres-rows entry"];
    }
    if (!POSTGRES_DELETE_ORDER.includes(parsed.table)) {
      return [
        `postgres-rows entry names unexpected table "${parsed.table}" — ` +
          "refusing a delete outside the recorded fabrication set",
      ];
    }
    try {
      const postgres = await connectSimulatorPostgres(ctx.env);
      try {
        const pks = parsed.pks.map((pk) => String(pk));
        // active_version_id references versions; detach before deleting
        // versions of still-present fabricated apps.
        if (parsed.table === "deploy_deployappversion") {
          await postgres.query(
            `UPDATE deploy_deployapp SET active_version_id = NULL
             WHERE active_version_id = ANY($1::bigint[])`,
            [pks],
          );
        }
        await postgres.query(
          `DELETE FROM ${parsed.table} WHERE id = ANY($1::bigint[])`,
          [pks],
        );
        return [];
      } finally {
        await postgres.end().catch(() => undefined);
      }
    } catch (err) {
      return [
        `delete from ${parsed.table} by recorded PKs: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      ];
    }
  },
};
