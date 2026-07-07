#!/usr/bin/env node
/* global console, fetch, process */

// Repo-owned replacement for the backend's embedded `smbe local-dev-env`
// template seeder.
//
// Rationale: the backend binary ships a hardcoded GraphQL query against the
// public registry, so any registry schema change strands every already-built
// backend image (see the 2026-07 `AppTemplate.category` object->String break).
// Owning the query in this repo means schema drift is fixed with a one-line PR
// here instead of a backend release, and any pinned backend image keeps
// working (`bootstrap.sh` passes `--skip-templates` when supported).
//
// Behavior mirrors backend `seed_templates.rs`: fetch all templates from the
// source registry, upsert categories/frameworks/languages/templates by slug
// into the local Postgres, then depublish templates missing from the source.

import fs from "node:fs";
import path from "node:path";

import pg from "pg";

// argv: [repoDir] [runDir] - repoDir is accepted for symmetry with
// seed-packages.mjs but not currently needed.
const runDir = process.argv[3] ? path.resolve(process.argv[3]) : null;

const sourceRegistry =
  process.env.LOCAL_PLATFORM_TEMPLATE_SOURCE_REGISTRY ??
  "https://registry.wasmer.io/graphql";
const sourceToken = process.env.LOCAL_PLATFORM_TEMPLATE_SOURCE_TOKEN;
const postgresUrl =
  process.env.LOCAL_PLATFORM_POSTGRES_URL ??
  `postgresql://postgres:postgres@localhost:${process.env.POSTGRES_PORT ?? "15432"}/wapm`;

const UNKNOWN_FRAMEWORK = {
  slug: "unknown-framework",
  name: "Unknown Framework",
};
const UNKNOWN_LANGUAGE = { slug: "unknown-language", name: "Unknown Language" };
const UNKNOWN_CATEGORY = {
  slug: "uncategorized",
  name: "Uncategorized",
  description: "",
};

const TEMPLATE_FIELDS_COMMON = `
        slug
        name
        defaultImage
        description
        demoUrl
        repoUrl
        rootDir
        branch
        readme
        useCases
        repoLicense
        canDeployWithoutRepo
        completionTimeInSeconds
        highlighted
        templateFramework { slug name }
        templateLanguage { slug name }`;

// Ordered query variants: the current registry contract first, then known
// legacy shapes. The first variant the source accepts is reused for all pages,
// so a contract change on either side degrades to the matching variant instead
// of failing the bootstrap.
const QUERY_VARIANTS = [
  {
    id: "category-string",
    query: `query($after:String){
  getAppTemplates(after:$after, first:50){
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        category${TEMPLATE_FIELDS_COMMON}
      }
    }
  }
}`,
    normalizeCategory: (node) =>
      typeof node.category === "string" && node.category.trim() !== ""
        ? {
            slug: node.category,
            name: node.category.replace(/[-_]/g, " "),
            description: "",
          }
        : null,
  },
  {
    id: "category-object",
    query: `query($after:String){
  getAppTemplates(after:$after, first:50){
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        category { slug name description }${TEMPLATE_FIELDS_COMMON}
      }
    }
  }
}`,
    normalizeCategory: (node) =>
      node.category && typeof node.category === "object"
        ? {
            slug: node.category.slug ?? UNKNOWN_CATEGORY.slug,
            name: node.category.name ?? UNKNOWN_CATEGORY.name,
            description: node.category.description ?? "",
          }
        : null,
  },
];

async function graphqlRequest(query, variables) {
  const headers = { "Content-Type": "application/json" };
  if (sourceToken) {
    headers.Authorization = `Bearer ${sourceToken}`;
  }
  const response = await fetch(sourceRegistry, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Source registry ${sourceRegistry} returned HTTP ${response.status}: ${body.slice(0, 500)}`,
    );
  }
  const payload = JSON.parse(body);
  if (payload.errors) {
    const error = new Error(
      `Source registry GraphQL errors: ${JSON.stringify(payload.errors).slice(0, 1000)}`,
    );
    error.graphqlErrors = true;
    throw error;
  }
  return payload.data;
}

async function fetchAllTemplates() {
  const variantErrors = [];

  // Pick the first variant the source schema accepts.
  for (const candidate of QUERY_VARIANTS) {
    try {
      const data = await graphqlRequest(candidate.query, { after: null });
      console.log(
        `Template query variant '${candidate.id}' accepted by source`,
      );
      const templates = [];
      let page = data.getAppTemplates;
      collectPage(templates, page, candidate);
      while (page.pageInfo.hasNextPage) {
        const nextData = await graphqlRequest(candidate.query, {
          after: page.pageInfo.endCursor,
        });
        page = nextData.getAppTemplates;
        collectPage(templates, page, candidate);
      }
      return { templates, variant: candidate.id };
    } catch (error) {
      if (!error.graphqlErrors) {
        throw error;
      }
      variantErrors.push(`variant '${candidate.id}': ${error.message}`);
    }
  }

  throw new Error(
    `No template query variant matched the source registry schema at ${sourceRegistry}. ` +
      `Update QUERY_VARIANTS in local-platform/scripts/seed-app-templates.mjs to match the ` +
      `current getAppTemplates contract.\n${variantErrors.join("\n")}`,
  );
}

function collectPage(templates, page, variant) {
  for (const edge of page.edges ?? []) {
    const node = edge?.node;
    if (!node || typeof node.slug !== "string" || node.slug === "") {
      continue;
    }
    templates.push({
      slug: node.slug,
      name: node.name ?? node.slug,
      defaultImage: node.defaultImage ?? null,
      description: node.description ?? "",
      demoUrl: nonEmptyOr(node.demoUrl, "https://wasmer.io"),
      repoUrl: nonEmptyOr(
        node.repoUrl,
        "https://github.com/wasmer-examples/static-website",
      ),
      rootDir: node.rootDir ?? null,
      branch: node.branch ?? null,
      readme: nonEmptyOr(
        node.readme,
        "Seeded by wasmer-integration-tests seed-app-templates",
      ),
      useCases: normalizeUseCases(node.useCases),
      repoLicense: node.repoLicense ?? "",
      canDeployWithoutRepo: Boolean(node.canDeployWithoutRepo),
      completionTimeInSeconds:
        Number(node.completionTimeInSeconds) > 0
          ? Number(node.completionTimeInSeconds)
          : 30,
      highlighted: Boolean(node.highlighted),
      category: variant.normalizeCategory(node) ?? UNKNOWN_CATEGORY,
      framework: node.templateFramework ?? UNKNOWN_FRAMEWORK,
      language: node.templateLanguage ?? UNKNOWN_LANGUAGE,
    });
  }
}

function nonEmptyOr(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function normalizeUseCases(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // fall through: wrap the raw string
    }
    return [value];
  }
  return [];
}

// --- Postgres upserts -------------------------------------------------------
//
// Columns are intersected with information_schema at runtime so the seeder
// works across backend image generations whose migrations added or removed
// optional columns.

async function tableColumns(client, table) {
  const res = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  if (res.rows.length === 0) {
    throw new Error(
      `Table '${table}' does not exist in the local backend database - did backend migrations run?`,
    );
  }
  return new Set(res.rows.map((row) => row.column_name));
}

function filterColumns(values, columns) {
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => columns.has(key)),
  );
}

async function upsertBySlug(client, table, columns, slug, values) {
  const present = filterColumns(values, columns);
  const existing = await client.query(
    `SELECT id FROM ${table} WHERE slug = $1 ORDER BY id LIMIT 1`,
    [slug],
  );
  if (existing.rows.length > 0) {
    const id = existing.rows[0].id;
    const keys = Object.keys(present).filter((key) => key !== "created_at");
    if (keys.length > 0) {
      const assignments = keys
        .map((key, index) => `${key} = $${index + 2}`)
        .join(", ");
      await client.query(`UPDATE ${table} SET ${assignments} WHERE id = $1`, [
        id,
        ...keys.map((key) => present[key]),
      ]);
    }
    return id;
  }

  const keys = Object.keys(present);
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
  const res = await client.query(
    `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders}) RETURNING id`,
    keys.map((key) => present[key]),
  );
  return res.rows[0].id;
}

async function main() {
  const started = Date.now();
  const { templates, variant } = await fetchAllTemplates();
  console.log(
    `Fetched ${templates.length} templates from ${sourceRegistry} (variant: ${variant})`,
  );

  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();

  let upserted = 0;
  let depublished = 0;
  try {
    const now = new Date();
    const categoryColumns = await tableColumns(
      client,
      "deploy_apptemplatecategory",
    );
    const frameworkColumns = await tableColumns(
      client,
      "deploy_templateframework",
    );
    const languageColumns = await tableColumns(
      client,
      "deploy_templatelanguage",
    );
    const templateColumns = await tableColumns(client, "deploy_apptemplate");

    for (const template of templates) {
      const categoryId = await upsertBySlug(
        client,
        "deploy_apptemplatecategory",
        categoryColumns,
        template.category.slug,
        {
          slug: template.category.slug,
          name: template.category.name,
          description: template.category.description,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        },
      );
      const frameworkId = await upsertBySlug(
        client,
        "deploy_templateframework",
        frameworkColumns,
        template.framework.slug,
        {
          slug: template.framework.slug,
          name: template.framework.name,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        },
      );
      const languageId = await upsertBySlug(
        client,
        "deploy_templatelanguage",
        languageColumns,
        template.language.slug,
        {
          slug: template.language.slug,
          name: template.language.name,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        },
      );

      await upsertBySlug(
        client,
        "deploy_apptemplate",
        templateColumns,
        template.slug,
        {
          slug: template.slug,
          name: template.name,
          default_image: template.defaultImage,
          description: template.description,
          demo_url: template.demoUrl,
          repo_url: template.repoUrl,
          root_dir: template.rootDir,
          branch: template.branch,
          readme: template.readme,
          is_public: true,
          use_cases: JSON.stringify(template.useCases),
          repo_license: template.repoLicense,
          category_id: categoryId,
          framework_id: frameworkId,
          language_id: languageId,
          can_deploy_without_repo: template.canDeployWithoutRepo,
          completion_time_in_seconds: template.completionTimeInSeconds,
          highlighted: template.highlighted,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          default_image_updated_at: now,
        },
      );
      upserted += 1;
    }

    const slugs = templates.map((template) => template.slug);
    const result = await client.query(
      `UPDATE deploy_apptemplate
       SET is_public = false, updated_at = $2
       WHERE deleted_at IS NULL AND is_public = true AND slug <> ALL($1)`,
      [slugs, now],
    );
    depublished = result.rowCount ?? 0;
  } finally {
    await client.end();
  }

  const summary = {
    sourceRegistry,
    variant,
    templatesUpserted: upserted,
    templatesDepublished: depublished,
    durationMs: Date.now() - started,
  };
  console.log(
    `seed-app-templates complete: upserted=${upserted} depublished=${depublished} (${summary.durationMs}ms)`,
  );
  if (runDir) {
    const diagnosticsPath = path.join(
      runDir,
      "diagnostics",
      "template-seed.json",
    );
    fs.mkdirSync(path.dirname(diagnosticsPath), { recursive: true });
    fs.writeFileSync(diagnosticsPath, JSON.stringify(summary, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
