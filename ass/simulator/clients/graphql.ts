// Backend GraphQL client for the simulator. Every instance passes its
// endpoint through the D-K connection-time guard, so no code path — not
// even a bug — can point these mutations at a non-loopback registry. Kept
// separate from src/backend.ts's BackendClient because the simulator needs
// the account lifecycle (register/adopt/token-mint) that tests never touch,
// and must not drag the heavy TestEnv dependency tree into the CLI.

import { guardedUrl } from "../guard";

export class BackendGraphqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendGraphqlError";
  }
}

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export class SimulatorBackend {
  private readonly url: string;
  private token: string | null;

  constructor(registryUrl: string, token: string | null = null) {
    this.url = guardedUrl("WASMER_REGISTRY", registryUrl);
    this.token = token;
  }

  withToken(token: string): SimulatorBackend {
    return new SimulatorBackend(this.url, token);
  }

  async gql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token !== null
          ? { Authorization: `Bearer ${this.token}` }
          : {}),
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new BackendGraphqlError(
        `backend returned HTTP ${response.status}: ${text.slice(0, 300)}`,
      );
    }
    let payload: GqlResponse<T>;
    try {
      payload = JSON.parse(text) as GqlResponse<T>;
    } catch {
      throw new BackendGraphqlError(
        `backend returned non-JSON: ${text.slice(0, 300)}`,
      );
    }
    if (payload.errors !== undefined && payload.errors.length > 0) {
      throw new BackendGraphqlError(
        payload.errors.map((error) => error.message).join("; "),
      );
    }
    if (payload.data === undefined) {
      throw new BackendGraphqlError("backend returned no data");
    }
    return payload.data;
  }

  /** null when the username is already taken (the adoption path). */
  async registerUser(input: {
    username: string;
    email: string;
    password: string;
  }): Promise<string | null> {
    try {
      const data = await this.gql<{ registerUser: { token: string | null } }>(
        `mutation($input: RegisterUserInput!) {
          registerUser(input: $input) { token }
        }`,
        {
          input: {
            username: input.username,
            email: input.email,
            password: input.password,
            fullName: "Simulated User",
            acceptedTos: true,
          },
        },
      );
      if (data.registerUser.token === null) {
        throw new BackendGraphqlError(
          "registerUser returned no token and no errors",
        );
      }
      return data.registerUser.token;
    } catch (err) {
      if (
        err instanceof BackendGraphqlError &&
        /already|taken|exists|registered/i.test(err.message)
      ) {
        return null;
      }
      throw err;
    }
  }

  async tokenAuth(username: string, password: string): Promise<string> {
    const data = await this.gql<{ tokenAuth: { token: string } }>(
      `mutation($input: ObtainJSONWebTokenInput!) {
        tokenAuth(input: $input) { token }
      }`,
      { input: { username, password } },
    );
    return data.tokenAuth.token;
  }

  async generateApiToken(identifier: string): Promise<string> {
    const data = await this.gql<{
      generateApiToken: { tokenRaw: string | null };
    }>(
      `mutation($input: GenerateAPITokenInput!) {
        generateApiToken(input: $input) { tokenRaw }
      }`,
      { input: { identifier } },
    );
    if (data.generateApiToken.tokenRaw === null) {
      throw new BackendGraphqlError("generateApiToken returned no tokenRaw");
    }
    return data.generateApiToken.tokenRaw;
  }

  async viewer(): Promise<{ id: string; username: string }> {
    const data = await this.gql<{
      viewer: { id: string; username: string } | null;
    }>(`{ viewer { id username } }`);
    if (data.viewer === null) {
      throw new BackendGraphqlError("viewer is null — token not accepted");
    }
    return data.viewer;
  }

  async getNamespace(name: string): Promise<{ id: string } | null> {
    const data = await this.gql<{ getNamespace: { id: string } | null }>(
      `query($name: String!) { getNamespace(name: $name) { id } }`,
      { name },
    );
    return data.getNamespace;
  }

  async createNamespace(name: string): Promise<string> {
    const data = await this.gql<{
      createNamespace: { namespace: { id: string } };
    }>(
      `mutation($input: CreateNamespaceInput!) {
        createNamespace(input: $input) { namespace { id name } }
      }`,
      { input: { name } },
    );
    return data.createNamespace.namespace.id;
  }

  async appsInNamespace(
    namespace: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const apps: Array<{ id: string; name: string }> = [];
    let after: string | null = null;
    for (;;) {
      const data: {
        getNamespace: {
          apps: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            edges: Array<{ node: { id: string; name: string } | null }>;
          };
        } | null;
      } = await this.gql(
        `query($namespace: String!, $after: String) {
          getNamespace(name: $namespace) {
            apps(first: 100, after: $after, sortBy: NEWEST) {
              pageInfo { hasNextPage endCursor }
              edges { node { id name } }
            }
          }
        }`,
        { namespace, after },
      );
      if (data.getNamespace === null) {
        return apps;
      }
      for (const edge of data.getNamespace.apps.edges) {
        if (edge.node !== null) {
          apps.push(edge.node);
        }
      }
      if (!data.getNamespace.apps.pageInfo.hasNextPage) {
        return apps;
      }
      after = data.getNamespace.apps.pageInfo.endCursor;
    }
  }

  /** Idempotent: an already-deleted or unknown app is success. */
  async deleteApp(appId: string): Promise<void> {
    try {
      await this.gql<{ deleteApp: { success: boolean } }>(
        `mutation($id: ID!) { deleteApp(input: { id: $id }) { success } }`,
        { id: appId },
      );
    } catch (err) {
      if (
        err instanceof BackendGraphqlError &&
        /not found|does not exist|already deleted|permission/i.test(err.message)
      ) {
        return;
      }
      throw err;
    }
  }

  async deleteUser(userId: string): Promise<void> {
    try {
      await this.gql<{ deleteUser: { deleted: boolean } }>(
        `mutation($id: ID!) { deleteUser(input: { userId: $id }) { deleted } }`,
        { id: userId },
      );
    } catch (err) {
      if (
        err instanceof BackendGraphqlError &&
        /not found|does not exist|already deleted/i.test(err.message)
      ) {
        return;
      }
      throw err;
    }
  }
}
