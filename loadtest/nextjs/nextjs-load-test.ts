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
 * See also nextjs-load-test-local.ts, which runs the same fixture locally via
 * `wasmer run` instead of deploying it, so it can read the process's own
 * memory usage directly.
 *
 * Run `pnpm run loadtest:nextjs --help` for CLI details.
 */

import process from "node:process";

import { TestEnv, flushPendingAppCleanups } from "../../src/env";
import type { AppInfo } from "../../src/backend";
import { copyPackageAnonymous } from "../../src/package";
import { randomAppName } from "../../src/app/construct";
import { resolveOwner } from "../../src/wasmer_cli";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_COUNT,
  FIXTURE_DIR,
  positiveInteger,
  routeCount,
  routePaths,
  runArtillery,
} from "./shared";

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
route (the home page plus ${routeCount() - 1} post pages), and deletes the
app afterward.

Options:
  --concurrency <number>   Concurrent Artillery virtual users (default: ${DEFAULT_CONCURRENCY})
  --count <number>         Times each virtual user loads every route (default: ${DEFAULT_COUNT})
  --owner <namespace>      Owner namespace to deploy under (default: resolved from the wasmer CLI)
  -h, --help               Show this help message

Set KEEP_APPS=1 to preserve the deployed app instead of deleting it.`);
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
