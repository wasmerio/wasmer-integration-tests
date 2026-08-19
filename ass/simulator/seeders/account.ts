// Account seeder (spec §3.1 step 1): register or adopt the scenario user,
// mint an API token so everything downstream runs *as that user*, create
// the org namespace (the dashboard's [org] pages resolve getNamespace, and
// a bare username is not a Namespace — verified empirically 2026-08-14),
// and read back the numeric PKs ClickHouse rows are keyed by.

import { SimulatorBackend, BackendGraphqlError } from "../clients/graphql";
import { connectSimulatorPostgres } from "../clients/postgres";
import type { EmitEntry, SeedContext, Seeder } from "../registry";
import type { SimulatorDeclaration } from "../schema";

export interface AccountEntry {
  kind: "account";
  username: string;
  namespace: string;
  /** Opaque backend IDs (u_…, ns_…); never secrets. */
  userId: string;
  namespaceId: string | null;
  /** True when this seed created the namespace (vs adopted an existing). */
  createdNamespace: boolean;
  /** The superuser lens: pinned identities are kept on teardown so browser
   * sessions survive scenario switches. */
  pinned: boolean;
}

export const accountSeeder: Seeder = {
  block: "account",

  plan(declaration: SimulatorDeclaration): string[] {
    const account = declaration.account;
    return [
      `account: user "${account.username}" with namespace ` +
        `"${account.namespace}" (registered or adopted; API token minted)`,
    ];
  },

  async apply(
    declaration: SimulatorDeclaration,
    ctx: SeedContext,
    emit: EmitEntry,
  ): Promise<void> {
    const account = declaration.account;
    const registry = ctx.env["WASMER_REGISTRY"];
    const anonymous = new SimulatorBackend(registry);

    const email = `${account.username}@simulated.local`;
    const registered = await anonymous.registerUser({
      username: account.username,
      email,
      password: account.password,
    });
    let jwt = registered;
    if (jwt === null) {
      // D-I adoption: the account exists; it must be ours (same password).
      try {
        jwt = await anonymous.tokenAuth(account.username, account.password);
      } catch (err) {
        throw new Error(
          `account "${account.username}" already exists but the declared ` +
            "password does not authenticate. Reseed rule (D-I): an existing " +
            "identical account is adopted; a mismatched one is never " +
            `hijacked. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      ctx.io.err(`account: adopted existing user "${account.username}"`);
    } else {
      ctx.io.err(`account: registered user "${account.username}"`);
    }

    const asUser = anonymous.withToken(jwt);
    const viewer = await asUser.viewer();
    const apiToken = await asUser.generateApiToken("business-simulator");

    let namespaceId: string | null = null;
    let createdNamespace = false;
    const existing = await asUser.getNamespace(account.namespace);
    if (existing !== null) {
      namespaceId = existing.id;
      ctx.io.err(`account: adopted existing namespace "${account.namespace}"`);
    } else {
      try {
        namespaceId = await asUser.createNamespace(account.namespace);
        createdNamespace = true;
        ctx.io.err(`account: created namespace "${account.namespace}"`);
      } catch (err) {
        throw new BackendGraphqlError(
          `cannot create namespace "${account.namespace}": ` +
            `${err instanceof Error ? err.message : String(err)}. The org ` +
            "namespace is what the dashboard's pages resolve; without it " +
            "nothing downstream can render. Pick a namespace name that is " +
            "not already taken by another user or org.",
        );
      }
    }

    if (account.pinned) {
      ctx.io.err(
        "account: pinned — identity (user + namespace) survives teardown, " +
          "so signed-in sessions outlive scenario switches",
      );
    }
    emit({
      kind: "account",
      username: account.username,
      namespace: account.namespace,
      userId: viewer.id,
      namespaceId,
      createdNamespace,
      pinned: account.pinned,
    } satisfies AccountEntry);

    // Numeric PKs (ClickHouse app_owner_id correlation) come from the
    // backend database — the GraphQL surface only exposes opaque IDs.
    const postgres = await connectSimulatorPostgres(ctx.env);
    try {
      const namespacePk = await postgres.query<{ id: number }>(
        "SELECT id FROM registry_namespace WHERE external_id = $1 AND deleted_at IS NULL",
        [namespaceId],
      );
      if (namespacePk.rows.length !== 1) {
        throw new Error(
          `namespace "${account.namespace}" (${namespaceId}) has no ` +
            "registry_namespace row — ID read-back failed, refusing to " +
            "proceed with partial correlation",
        );
      }
      const userPk = await postgres.query<{ id: number }>(
        "SELECT id FROM auth_user WHERE username = $1",
        [account.username],
      );
      if (userPk.rows.length !== 1) {
        throw new Error(
          `user "${account.username}" has no auth_user row — ID read-back ` +
            "failed, refusing to proceed with partial correlation",
        );
      }
      ctx.ids.userId = viewer.id;
      ctx.ids.namespace = account.namespace;
      ctx.ids.token = apiToken;
      ctx.ids.namespaceId = namespaceId ?? undefined;
      ctx.ids.namespacePk = namespacePk.rows[0].id;
      ctx.ids.userPk = userPk.rows[0].id;
      if (ctx.verbose) {
        ctx.io.err(
          `account: userId=${viewer.id} namespacePk=${namespacePk.rows[0].id}`,
        );
      }
    } finally {
      await postgres.end().catch(() => undefined);
    }
  },
};
