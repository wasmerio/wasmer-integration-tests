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
  // Best-effort test/deployment origin, used for debugging retained apps.
  origin?: string;
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

const appRegionSchema = z.object({
  id: z.string(),
  name: z.string(),
  country: z.string(),
  city: z.string(),
  supportsVolumes: z.boolean(),
  supportsDbs: z.boolean(),
  active: z.boolean(),
});

export type AppRegion = z.infer<typeof appRegionSchema>;

const appRegionFiltersSchema = z.object({
  active: z.boolean().optional(),
  supportsVolumes: z.boolean().optional(),
  supportsDatabases: z.boolean().optional(),
});

export type AppRegionFilters = z.infer<typeof appRegionFiltersSchema>;

const apiAppRegionsSchema = z.object({
  pageInfo: pageInfoSchema,
  regions: z.array(appRegionSchema),
});

export type ApiAppRegions = z.infer<typeof apiAppRegionsSchema>;

const apiAppRegionsResponseSchema = z.object({
  getAppRegions: z.object({
    pageInfo: pageInfoSchema,
    edges: z.array(
      z.object({
        node: appRegionSchema.nullable(),
      }),
    ),
  }),
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
    const query = `
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
    `;

    // The backend can briefly return an incomplete node right after a deploy
    // (e.g. activeVersion not yet assigned), so re-fetch a few times before
    // giving up.
    const AM_RETRIES = 3;
    const errors: string[] = [];
    for (let i = 0; i < AM_RETRIES; i++) {
      if (i > 0) {
        await sleep(5000);
      }
      const res = await this.gqlQuery<nodeLike>(query, { id: appId });
      const nodeParse = nodeLike.safeParse(res.data);
      if (!nodeParse.success) {
        console.debug({ res });
        errors.push(
          `attempt ${i + 1}: failed to parse app node: ${nodeParse.error}`,
        );
        continue;
      }

      const node = nodeParse.data.node;
      return {
        id: node.id,
        url: node.url,
        permalink: node.permalink,
        activeVersionId: node.activeVersion?.id ?? null,
      };
    }
    throw new Error(
      `Failed to load app ${appId} after ${AM_RETRIES} attempts:\n${errors.join("\n")}`,
    );
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

  async getAppRegions(
    filters: AppRegionFilters = {},
    after: string | null = null,
  ): Promise<ApiAppRegions> {
    const query = `
query($active:Boolean, $supportsVolumes:Boolean, $supportsDatabases:Boolean, $after:String) {
  getAppRegions(
    active:$active,
    supportsVolumes:$supportsVolumes,
    supportsDatabases:$supportsDatabases,
    first:100,
    after:$after
  ) {
    pageInfo {
      hasNextPage
      endCursor
    }
    edges {
      node {
        id
        name
        country
        city
        supportsVolumes
        supportsDbs
        active
      }
    }
  }
}
    `;

    const parsedFilters = appRegionFiltersSchema.parse(filters);
    const res = await this.gqlQuery(query, {
      active: parsedFilters.active,
      supportsVolumes: parsedFilters.supportsVolumes,
      supportsDatabases: parsedFilters.supportsDatabases,
      after,
    });
    const parsed = apiAppRegionsResponseSchema.parse(res.data!);
    const data = parsed.getAppRegions;
    const regions = data.edges
      .map((edge) => edge.node)
      .filter((region): region is AppRegion => region !== null);
    return apiAppRegionsSchema.parse({
      pageInfo: data.pageInfo,
      regions,
    });
  }

  async getAllAppRegions(filters: AppRegionFilters = {}): Promise<AppRegion[]> {
    const allRegions: AppRegion[] = [];
    let after: string | null = null;
    while (true) {
      const page = await this.getAppRegions(filters, after);
      allRegions.push(...page.regions);
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    return allRegions;
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
