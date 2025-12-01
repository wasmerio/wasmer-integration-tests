import { DeployOutput } from "./wasmer_cli";
import { Path } from "./fs";

import { z } from "zod";
import { sleep } from "./util";

export interface GraphQlResponse<T> {
  data?: T;
  errors?: Error[];
}

export interface ApiDeployApp {
  id: string;
  url: string;
  permalink: string;
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
  apps: { id?: string; deleted?: boolean; createdAt?: string }[];
  lastCursor: string | null;
}

const appTemplateSchema = z.object({
  name: z.string(),
  slug: z.string(),
});

export type AppTemplate = z.infer<typeof appTemplateSchema>;

const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});

const apiAppTemplatesResponseSchema = z.object({
  getAppTemplates: z.object({
    pageInfo: pageInfoSchema,
    edges: z.array(
      z.object({
        node: appTemplateSchema,
      }),
    ),
  }),
});

export type ApiAppTemplates = {
  pageInfo: z.infer<typeof pageInfoSchema>;
  templates: AppTemplate[];
};

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
      Accept: "application/json",
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
        permalink: z.string(),
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
            permalink
            activeVersion {
              id
            }
          }
        }
      }
    `,
      { id: appId },
    );

    const AM_RETRIES = 2;
    let i = 0;
    const errors: Error[] = [];
    while (i < AM_RETRIES) {
      i++;
      const nodeParse = nodeLike.safeParse(res.data);

      if (!nodeParse.success) {
        console.debug({ res });
        errors.push(
          Error(
            `Failed to parse object for: ${appId}, error: ${nodeParse.error}`,
          ),
        );

        await sleep(5000);
        continue;
      }
      const node = nodeParse.data.node;

      const id = node.id;
      const url = node.url;
      const activeVersionId = node.activeVersion?.id ?? null;
      const permalink = node.permalink;

      const app: ApiDeployApp = {
        id,
        url,
        permalink,
        activeVersionId,
      };

      return app;
    }
    throw errors;
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
      data: z.object({
        getNamespace: z.object({
          apps: z.object({
            pageInfo: z.object({
              endCursor: z.string().nullable(),
            }),
            edges: z.array(nodeType),
          }),
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
    const data = namespaceQuery.parse(res).data.getNamespace.apps;
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

  async banApp({
    appId,
    reason,
    blackhole,
  }: {
    appId: string;
    reason: string;
    blackhole: boolean;
  }): Promise<string> {
    const Input = z.object({
      banApp: z.object({
        app: z.object({ id: z.string() }),
      }),
    });
    type Input = z.infer<typeof Input>;

    const query = `
      mutation($appId:ID!, $reason:String!,$blackholed:Boolean!) {
        banApp(input:{appId:$appId, reason:$reason, blackholed:$blackholed}) {
          app {
            id
          }
        }
      }
    `;

    const res = await this.gqlQuery<Input>(query, {
      appId,
      reason,
      blackholed: blackhole,
    });

    const id = res.data?.banApp?.app?.id;
    if (!id) {
      throw new Error("banApp mutation did not return an app id");
    }
    return id;
  }

  async getAppTemplates(after: string | null): Promise<ApiAppTemplates> {
    const query = `
query($after:String) {
  getAppTemplates(after:$after, first:50) {
    pageInfo {
      hasNextPage
      endCursor
    }

    edges {

      node {
        name
        slug
      }
    }
  }
}
    `;

    const res = await this.gqlQuery(query, {
      after,
    });
    const parsed = apiAppTemplatesResponseSchema.parse(res.data!);
    const data = parsed.getAppTemplates;
    const templates = data.edges.map((edge) => edge.node);
    return {
      pageInfo: data.pageInfo,
      templates,
    };
  }

  async getAllAppTemplates(): Promise<AppTemplate[]> {
    const allTemplates: AppTemplate[] = [];
    let after: string | null = null;
    while (true) {
      const page = await this.getAppTemplates(after);
      allTemplates.push(...page.templates);
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    return allTemplates;
  }
}
