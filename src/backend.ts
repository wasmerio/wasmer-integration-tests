import { DeployOutput } from "./wasmer_cli.ts";
import { Path } from "./fs.ts";

import { z } from "zod";

export interface GraphQlResponse<T> {
  data?: T;
  errors?: Error[];
}

export interface ApiDeployApp {
  id: string;
  url: string;
  activeVersionId: string | null;
}

export interface AppInfo {
  version: DeployOutput;
  app: ApiDeployApp;

  id: string;
  url: string;
  // Directory holding the app.
  dir: Path;
}

export interface ApiAppsInNamespace {
  apps: { id: string; deleted: boolean; createdAt: string }[];
  lastCursor: string | null;
}

export class BackendClient {
  url: string;
  token: string | null;

  constructor(url: string, token: string | null) {
    this.url = url;
    this.token = token;
  }

  // Send a GraphQL query to the backend.
  async gqlQuery<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<GraphQlResponse<T>> {
    const requestBody = JSON.stringify({
      query,
      variables,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const res = await fetch(this.url, {
      method: "POST",
      body: requestBody,
      headers,
    });

    const body = await res.text();
    if (!res.ok) {
      throw new Error(
        `Failed to send GraphQL query: ${res.status}\nBODY:\n${body}`,
      );
    }

    let response: GraphQlResponse<T>;
    try {
      response = JSON.parse(body);
    } catch (err) {
      throw new Error(
        `Failed to parse GraphQL JSON response: ${err}\nBODY:\n${body}`,
      );
    }
    if (response.errors) {
      throw new Error(
        `GraphQL query failed: ${JSON.stringify(response.errors)}`,
      );
    }
    if (!response.data) {
      throw new Error(`GraphQL query failed: no data returned`);
    }
    return response;
  }

  async getAppById(appId: string): Promise<ApiDeployApp> {
    const nodeLike = z.object({
      node: z.object({
        id: z.string(),
        url: z.string(),
        activeVersion: z.object({
          id: z.string(),
        }),
      }),
    });
    type nodeLike = z.infer<typeof nodeLike>;
    const res = await this.gqlQuery<nodeLike>(
      `
      query($id:ID!) {
        node(id:$id) {
          ... on DeployApp {
            id
            url
            activeVersion {
              id
            }
          }
        }
      }
    `,
      { id: appId },
    );

    const node = nodeLike.parse(res.data).node;
    if (!node) {
      console.debug({ res });
      throw new Error(`App not found: ${appId}`);
    }

    const id = node.id;
    const url = node.url;
    const activeVersionId = node.activeVersion?.id ?? null;

    const app: ApiDeployApp = {
      id,
      url,
      activeVersionId,
    };

    return app;
  }

  async appsInNamespace(
    namespace: string,
    after: string | null,
  ): Promise<ApiAppsInNamespace> {
    const nodeType = z.object({
      node: z.object({
        id: z.string(),
        deleted: z.boolean(),
        createdAt: z.string(),
      }),
    });
    const namespaceQuery = z.object({
      getNamespace: z.object({
        apps: z.object({
          pageInfo: z.object({
            endCursor: z.string().nullable(),
          }),
          edges: z.array(nodeType),
        }),
      }),
    });

    type namespaceQuery = z.infer<typeof namespaceQuery>;
    type nodeType = z.infer<typeof nodeType>;

    const query = `
query($namespace:String!, $after:String) {
  getNamespace(name:$namespace) {
    apps(sortBy:NEWEST, after:$after) {
      pageInfo {
        endCursor
      }
      edges {
        node {
          id
          deleted
          createdAt
        }
      }
    }
  }
}
    `;

    const res = await this.gqlQuery<namespaceQuery>(query, {
      namespace,
      after,
    });
    const data = namespaceQuery.parse(res).getNamespace.apps;
    const lastCursor: string | null = data!.pageInfo.endCursor;
    const edges = data.edges;
    const apps = edges.map((e: nodeType) => e.node);
    return { apps, lastCursor };
  }

  async deleteApp(appId: string): Promise<void> {
    const deleteAppMutation = z.object({
      deleteApp: z.object({
        success: z.boolean(),
      }),
    });

    type deleteAppMutation = z.infer<typeof deleteAppMutation>;

    const query = `
mutation($id:ID!) {
  deleteApp(input:{id:$id}) {
    success
  }
}
`;

    const res = await this.gqlQuery<deleteAppMutation>(query, { id: appId });
    const success = deleteAppMutation.parse(res.data).deleteApp.success;
    if (!success) {
      throw new Error(`Failed to delete app: ${appId}`);
    }
  }
}
