// Identity adapters: the scenario user and its workspace. Both go through
// the enumerated identity client (section 13) because the SDK exposes no
// account lifecycle and no namespace resource - every call here is a
// tracked upstream ask, and none of them duplicates something the pinned
// SDK covers.

import { BackendGraphqlError, SimulatorBackend } from "../../clients/graphql";
import { defaultDiff, type ResourceAdapter, type Scope } from "../adapter";
import {
  id,
  resource,
  type OpResult,
  type Operation,
  type Resource,
} from "../model";
import type { NamespaceSpec, UserSpec } from "../specs";
import type { EngineContext } from "../engine/context";
import { ensureUserClient, failed, namespaceFacts, ok, userPk } from "./common";

export const userAdapter: ResourceAdapter<UserSpec> = {
  kind: "user",
  lane: "sdk",
  granularity: "resource",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<UserSpec>[]> {
    return observeUsers(ctx, scope);
  },

  diff(desired, observed) {
    return defaultDiff("sdk", desired, observed);
  },

  async apply(
    ops: Operation<UserSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    const results: OpResult[] = [];
    for (const operation of ops) {
      try {
        if (operation.type === "delete") {
          const userId = ctx.identity.requireString(operation.id, "userId");
          await ctx.admin.deleteUser(userId);
          results.push(ok(operation.id));
          continue;
        }
        const spec = operation.desired?.spec;
        if (spec === undefined) {
          continue;
        }
        const registry = ctx.env["WASMER_REGISTRY"];
        const anonymous = new SimulatorBackend(registry);
        let jwt = await anonymous.registerUser({
          username: spec.username,
          email: spec.email,
          password: spec.password,
        });
        if (jwt === null) {
          try {
            jwt = await anonymous.tokenAuth(spec.username, spec.password);
          } catch (err) {
            throw new Error(
              `user "${spec.username}" already exists but the declared password does ` +
                "not authenticate. An existing identical account is adopted; a " +
                `mismatched one is never hijacked. Underlying error: ${
                  err instanceof Error ? err.message : String(err)
                }`,
            );
          }
        }
        const asUser = anonymous.withToken(jwt);
        const viewer = await asUser.viewer();
        const apiToken = await asUser.generateApiToken("business-simulator");
        ctx.user = anonymous.withToken(apiToken);
        const pk = await userPk(ctx, spec.username);
        ctx.identity.bind(operation.id, {
          userId: viewer.id,
          token: apiToken,
          ...(pk !== null ? { pk } : {}),
        });
        results.push(ok(operation.id, { users: 1 }));
      } catch (err) {
        results.push(failed(operation.id, err));
      }
    }
    return results;
  },
};

async function observeUsers(
  ctx: EngineContext,
  scope: Scope,
): Promise<Resource<UserSpec>[]> {
  // The identity rows are shared with the human using the platform, so the
  // observation is name-scoped rather than marker-scoped: a user the
  // scenario declares either exists or does not.
  const rows = await ctx.withPostgres((client) =>
    client.query<{
      id: number;
      username: string;
      email: string;
      external_id: string | null;
    }>(
      // `external_id` is the opaque id the GraphQL surface speaks, which is
      // what the admin delete mutation takes.
      `SELECT id, username, email, external_id FROM auth_user WHERE username = $1`,
      [scope.username],
    ),
  );
  return rows.rows.map((row) => {
    const resourceId = id("user", row.username);
    ctx.identity.bind(resourceId, {
      pk: row.id,
      ...(row.external_id !== null ? { userId: row.external_id } : {}),
    });
    return resource<UserSpec>({
      id: resourceId,
      spec: { username: row.username, email: row.email, password: "" },
      fingerprintOf: { username: row.username },
      policy: { prune: scope.pinned === false ? "delete" : "retain" },
    });
  });
}

export const namespaceAdapter: ResourceAdapter<NamespaceSpec> = {
  kind: "namespace",
  lane: "sdk",
  granularity: "resource",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<NamespaceSpec>[]> {
    const facts = await namespaceFacts(ctx, scope.namespace);
    if (facts === null) {
      return [];
    }
    const resourceId = id("namespace", scope.namespace);
    ctx.identity.bind(resourceId, {
      pk: facts.pk,
      externalId: facts.externalId,
    });
    return [
      resource<NamespaceSpec>({
        id: resourceId,
        spec: { name: scope.namespace, owner: "" },
        fingerprintOf: { name: scope.namespace, owner: "" },
        policy: { prune: scope.pinned === false ? "delete" : "retain" },
      }),
    ];
  },

  diff(desired, observed) {
    // A namespace is identified by its name; ownership is not re-declarable,
    // so an existing workspace of the right name is converged by definition.
    if (desired !== null && observed !== null) {
      return [];
    }
    return defaultDiff("sdk", desired, observed);
  },

  async apply(
    ops: Operation<NamespaceSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    const results: OpResult[] = [];
    for (const operation of ops) {
      try {
        if (operation.type === "delete") {
          // deleteNamespace no-ops for a non-maintainer (verified live), so
          // teardown mirrors the product's soft delete and frees the name.
          const pk = ctx.identity.requireNumber(operation.id, "pk");
          await ctx.withPostgres((client) =>
            client.query(
              `UPDATE registry_namespace
                  SET deleted_at = NOW(), name = name || '-simdel-' || id
                WHERE id = $1 AND deleted_at IS NULL`,
              [pk],
            ),
          );
          results.push(ok(operation.id));
          continue;
        }
        const spec = operation.desired?.spec;
        if (spec === undefined) {
          continue;
        }
        const { client: asUser } = await ensureUserClient(ctx);
        const existing = await asUser.getNamespace(spec.name);
        const externalId =
          existing !== null
            ? existing.id
            : await createNamespace(asUser, spec.name);
        const facts = await namespaceFacts(ctx, spec.name);
        if (facts === null) {
          throw new Error(
            `namespace "${spec.name}" (${externalId}) has no registry_namespace row - ` +
              "ID read-back failed, refusing to proceed with partial correlation",
          );
        }
        ctx.identity.bind(operation.id, { pk: facts.pk, externalId });
        results.push(ok(operation.id, { namespaces: 1 }));
      } catch (err) {
        results.push(failed(operation.id, err));
      }
    }
    return results;
  },
};

async function createNamespace(
  asUser: SimulatorBackend,
  name: string,
): Promise<string> {
  try {
    return await asUser.createNamespace(name);
  } catch (err) {
    throw new BackendGraphqlError(
      `cannot create namespace "${name}": ${err instanceof Error ? err.message : String(err)}. ` +
        "The org namespace is what the dashboard's pages resolve; without it nothing " +
        "downstream can render. Pick a name that is not already taken.",
    );
  }
}
