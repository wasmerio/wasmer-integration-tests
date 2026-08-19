// Shared adapter plumbing: ownership markers, content types, deterministic
// sim-marked external ids, and the small lookups every Postgres adapter
// needs. Prune predicates are always generated *into* the statement
// (section 8.1) - a buggy plan cannot widen its own blast radius.

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { EngineContext } from "../engine/context";

export interface SimMarker {
  managed: true;
  scenario: string;
  fingerprint: string;
  realism?: string;
}

export function simMarker(
  scenario: string,
  fingerprint: string,
  realism?: string,
): { sim: SimMarker } {
  return {
    sim: {
      managed: true,
      scenario,
      fingerprint,
      ...(realism ? { realism } : {}),
    },
  };
}

export function readMarker(annotations: unknown): SimMarker | null {
  if (annotations === null || typeof annotations !== "object") {
    return null;
  }
  const sim = (annotations as Record<string, unknown>)["sim"];
  if (sim === null || typeof sim !== "object") {
    return null;
  }
  const record = sim as Record<string, unknown>;
  if (record["managed"] !== true || typeof record["scenario"] !== "string") {
    return null;
  }
  return {
    managed: true,
    scenario: record["scenario"],
    fingerprint:
      typeof record["fingerprint"] === "string" ? record["fingerprint"] : "",
    realism:
      typeof record["realism"] === "string" ? record["realism"] : undefined,
  };
}

/** Deterministic, recognizable external id: `<prefix>_sim<9 chars>`, a pure
 * function of the resource key, so the same resource keeps the same id
 * across reseeds and ownership is visible in the row itself. */
export function simExternalId(prefix: string, resourceKey: string): string {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const hash = createHash("sha1").update(resourceKey).digest();
  let suffix = "";
  for (let index = 0; index < 9; index++) {
    suffix += alphabet[hash[index] % alphabet.length];
  }
  return `${prefix}_sim${suffix}`;
}

export function isSimExternalId(value: string | null | undefined): boolean {
  return typeof value === "string" && /_sim[A-Za-z0-9]{9}$/.test(value);
}

const contentTypeCache = new Map<string, number>();

export async function namespaceContentType(
  ctx: EngineContext,
): Promise<number> {
  const cached = contentTypeCache.get("registry.namespace");
  if (cached !== undefined) {
    return cached;
  }
  const rows = await ctx.withPostgres((client) =>
    client.query<{ id: number }>(
      `SELECT id FROM django_content_type WHERE app_label = 'registry' AND model = 'namespace'`,
    ),
  );
  if (rows.rows.length !== 1) {
    throw new Error("cannot resolve the registry.namespace content type id");
  }
  contentTypeCache.set("registry.namespace", rows.rows[0].id);
  return rows.rows[0].id;
}

export interface NamespaceFacts {
  pk: number;
  externalId: string;
  ownerPk: number | null;
}

export async function namespaceFacts(
  ctx: EngineContext,
  name: string,
): Promise<NamespaceFacts | null> {
  const result = await ctx.withPostgres((client) =>
    client.query<{ id: number; external_id: string }>(
      `SELECT id, external_id FROM registry_namespace WHERE name = $1 AND deleted_at IS NULL`,
      [name],
    ),
  );
  if (result.rows.length === 0) {
    return null;
  }
  return {
    pk: result.rows[0].id,
    externalId: result.rows[0].external_id,
    ownerPk: null,
  };
}

export async function userPk(
  ctx: EngineContext,
  username: string,
): Promise<number | null> {
  const result = await ctx.withPostgres((client) =>
    client.query<{ id: number }>(
      `SELECT id FROM auth_user WHERE username = $1`,
      [username],
    ),
  );
  return result.rows[0]?.id ?? null;
}

export function appDomain(ctx: EngineContext): string {
  return ctx.env["WASMER_APP_DOMAIN"] ?? "localhost";
}

/** A transaction on one pooled client; adapters batch inside it. */
export async function inTransaction<T>(
  ctx: EngineContext,
  task: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return ctx.withPostgres(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await task(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  });
}

/** The scenario user's API token. OBSERVE finds the user but does not mint
 * a token (that is a write), so the first adapter that needs to act *as*
 * the user mints one here - once per reconcile, cached in the identity map
 * like any other discovered identifier. */
export async function ensureUserClient(ctx: EngineContext): Promise<{
  client: import("../../clients/graphql").SimulatorBackend;
  token: string;
}> {
  const { SimulatorBackend } = await import("../../clients/graphql");
  const userId = {
    kind: "user" as const,
    segments: [ctx.credentials.username],
  };
  const cached = ctx.identity.native(userId)?.["token"];
  if (cached !== undefined && ctx.user !== null) {
    return { client: ctx.user, token: String(cached) };
  }
  const anonymous = new SimulatorBackend(ctx.env["WASMER_REGISTRY"]);
  const jwt = await anonymous.tokenAuth(
    ctx.credentials.username,
    ctx.credentials.password,
  );
  const token = await anonymous
    .withToken(jwt)
    .generateApiToken("business-simulator");
  ctx.identity.bind(userId, { token });
  ctx.user = anonymous.withToken(token);
  return { client: ctx.user, token };
}

export function ok(
  id: import("../model").ResourceId,
  stats?: Record<string, number>,
) {
  return { id, ok: true, ...(stats ? { stats } : {}) };
}

export function failed(id: import("../model").ResourceId, error: unknown) {
  return {
    id,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
