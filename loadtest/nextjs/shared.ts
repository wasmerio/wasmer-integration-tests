/**
 * Shared between nextjs-load-test.ts (deploys to Wasmer Edge) and
 * nextjs-load-test-local.ts (runs the same fixture locally via `wasmer run`):
 * the fixture location, its route list, CLI arg parsing, and the Artillery
 * config generation are identical between the two - only how the fixture
 * gets served differs.
 */

import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";

import { execa } from "execa";
import { dump } from "js-yaml";

import { POSTS } from "../../fixtures/nextjs/blog-load-test/lib/posts";

export const DEFAULT_CONCURRENCY = 10;
export const DEFAULT_COUNT = 1;
export const CACHE_CONTROL_HEADER = "no-cache, no-store, max-age=0";

// Both scripts are run via a `pnpm run loadtest:nextjs*` script, which always
// executes from the repo root, so process.cwd() is a reliable anchor here
// (these files are real ESM at runtime - no __dirname - unlike CommonJS-
// scoped code under src/).
export const FIXTURE_DIR = path.join(
  process.cwd(),
  "fixtures",
  "nextjs",
  "blog-load-test",
);

export function positiveInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, received: ${value}`);
  }

  return parsed;
}

export function routeCount(): number {
  return POSTS.length + 1;
}

export function routePaths(): string[] {
  return ["/", ...POSTS.map((post) => `/posts/${post.slug}`)];
}

// Prisma-backed route, exercised only by nextjs-load-test-local.ts (it needs
// a running Postgres, which the Edge variant doesn't provision).
export const DB_ROUTE = "/api/hit";

export async function runArtillery(
  routes: string[],
  concurrency: number,
  count: number,
  target: URL,
  scenarioName = "Load the Next.js blog fixture",
): Promise<void> {
  const workDir = await mkdtemp(path.join(tmpdir(), "nextjs-load-test-"));
  const configPath = path.join(workDir, "artillery.yml");
  const requests = routes.map((route) => ({ get: { url: route } }));

  await writeFile(
    configPath,
    dump({
      config: {
        target: target.origin,
        http: {
          defaults: {
            headers: {
              "cache-control": CACHE_CONTROL_HEADER,
            },
          },
        },
        phases: [
          {
            name: `Load every route with ${concurrency} virtual users`,
            duration: 1,
            arrivalCount: concurrency,
            maxVusers: concurrency,
          },
        ],
        plugins: {
          "metrics-by-endpoint": {},
        },
      },
      scenarios: [
        {
          name: scenarioName,
          flow: [
            {
              loop: requests,
              count,
            },
          ],
        },
      ],
    }),
  );

  console.info(
    `Load-testing ${routes.length} routes; Artillery input: ${workDir}`,
  );
  await execa("pnpm", ["exec", "artillery", "run", configPath], {
    stdio: "inherit",
  });
}
