/**
 * Deploys the fixtures/nextjs/blog-load-test Next.js app to Wasmer Edge, runs
 * an Artillery load test against every one of its routes, then tears the app
 * down.
 *
 * Unlike loadtest/wordpress/wordpress-load-test.mjs, this is not a generic
 * "point at any URL" tool: it only knows how to deploy its one bundled
 * fixture. The fixture's routes are known up front (see
 * fixtures/nextjs/blog-load-test/lib/posts.ts), so there is no crawl phase -
 * the route list is imported directly instead of discovered from HTML.
 *
 * Run `pnpm run loadtest:nextjs --help` for CLI details.
 */

import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";

import { execa } from "execa";
import { dump } from "js-yaml";

import { TestEnv, flushPendingAppCleanups } from "../../src/env";
import type { AppInfo } from "../../src/backend";
import { copyPackageAnonymous } from "../../src/package";
import { randomAppName } from "../../src/app/construct";
import { resolveOwner } from "../../src/wasmer_cli";
import { POSTS } from "../../fixtures/nextjs/blog-load-test/lib/posts";

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_COUNT = 1;
const CACHE_CONTROL_HEADER = "no-cache, no-store, max-age=0";

// Run via `pnpm run loadtest:nextjs`, which always executes from the repo
// root, so process.cwd() is a reliable anchor here (this file is real ESM at
// runtime - no __dirname - unlike CommonJS-scoped code under src/).
const FIXTURE_DIR = path.join(
  process.cwd(),
  "fixtures",
  "nextjs",
  "blog-load-test",
);

function positiveInteger(
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

interface ParsedArguments {
  help?: boolean;
  concurrency?: string;
  count?: string;
  owner?: string;
}

function parseArguments(args: string[]): ParsedArguments {
  let concurrency: string | undefined;
  let count: string | undefined;
  let owner: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }

    const [flag, inlineValue] = argument.split("=", 2);
    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }

    switch (flag) {
      case "--concurrency":
        concurrency = value;
        break;
      case "--count":
        count = value;
        break;
      case "--owner":
        owner = value;
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  return { concurrency, count, owner };
}

function printUsage(): void {
  console.info(`Usage: nextjs-load-test.ts [options]

Deploys fixtures/nextjs/blog-load-test to Wasmer Edge, load-tests every
route (the home page plus ${POSTS.length} post pages), and deletes the app
afterward.

Options:
  --concurrency <number>   Concurrent Artillery virtual users (default: ${DEFAULT_CONCURRENCY})
  --count <number>         Times each virtual user loads every route (default: ${DEFAULT_COUNT})
  --owner <namespace>      Owner namespace to deploy under (default: resolved from the wasmer CLI)
  -h, --help               Show this help message

Set KEEP_APPS=1 to preserve the deployed app instead of deleting it.`);
}

function routePaths(): string[] {
  return ["/", ...POSTS.map((post) => `/posts/${post.slug}`)];
}

async function runArtillery(
  routes: string[],
  concurrency: number,
  count: number,
  target: URL,
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
          name: "Load the Next.js blog fixture",
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

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const concurrency = positiveInteger(
    "--concurrency",
    options.concurrency,
    DEFAULT_CONCURRENCY,
  );
  const count = positiveInteger("--count", options.count, DEFAULT_COUNT);

  const env = TestEnv.fromEnv();
  const owner = options.owner ?? resolveOwner(env);

  const workDir = await copyPackageAnonymous(FIXTURE_DIR);

  let app: AppInfo | undefined;
  try {
    console.info(`Deploying ${FIXTURE_DIR} as ${owner}/...`);
    app = await env.deployAppDir(workDir, {
      extraCliArgs: [
        "--build-remote",
        "--owner",
        owner,
        "--app-name",
        randomAppName(),
      ],
    });
    console.info(`Deployed ${app.url}`);

    await runArtillery(routePaths(), concurrency, count, new URL(app.url));
  } finally {
    if (app) {
      await env.deleteApp(app);
      await flushPendingAppCleanups();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
