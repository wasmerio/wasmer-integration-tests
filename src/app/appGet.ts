import { z } from "zod";

export const AppAliasNode = z.object({
  name: z.string(),
  hostname: z.string(),
});

export const AppAliases = z.object({
  page_info: z.object({
    has_next_page: z.boolean(),
    end_cursor: z.string(),
  }),
  edges: z.array(z.object({ node: AppAliasNode })),
});

export const AppActiveVersion = z.object({
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  version: z.string(),
  description: z.string().nullable(),
  yaml_config: z.string(),
  user_yaml_config: z.string(),
  config: z.string(),
  json_config: z.string(),
  url: z.string(),
  disabled_at: z.string().nullable(),
  disabled_reason: z.string().nullable(),
  app: z.object({ id: z.string() }),
});

export const AppGet = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  description: z.string().nullable(),
  active_version: AppActiveVersion,
  admin_url: z.string(),
  owner: z.object({ global_name: z.string() }),
  url: z.string(),
  permalink: z.string(),
  deleted: z.boolean(),
  aliases: AppAliases,
  s3_url: z.string().nullable(),
});

export type AppGet = z.infer<typeof AppGet>;
