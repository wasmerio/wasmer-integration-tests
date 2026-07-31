/**
 * Runs the fixtures/nextjs/blog-load-test fixture locally with `wasmer run`
 * (instead of deploying it to Wasmer Edge, see nextjs-load-test.ts), so the
 * running instance's own process memory can be measured directly with `ps`
 * before and after two Artillery load tests - useful for observing a memory
 * leak without needing an HTTP diagnostic endpoint or Edge instance metrics.
 *
 * The fixture has no checked-in wasmer.toml (nextjs-load-test.ts relies on
 * `wasmer deploy --build-remote`'s auto-detection instead), so this script
 * builds one in a scratch copy of the fixture:
 *
 *   1. A throwaway Postgres container (via `docker`), migrated with
 *      `prisma db push` - backs the fixture's /api/hit route, which calls
 *      Prisma on every request.
 *   2. `pnpm install`, `prisma generate`, then `pnpm dlx next-bundle@1.0.0`
 *      (the same tool Wasmer's remote build pipeline uses) to produce a
 *      self-contained .next-bundle/server.mjs.
 *   3. A wasmer.toml declaring a dependency on wasmer/edgejs-quickjs,
 *      mounting .next-bundle at /app, and running /app/server.mjs - the same
 *      shape confirmed against the actual remote build's resolved runtime.
 *   4. `wasmer run . --net`, verified serving with one request, then two
 *      Artillery runs: the plain SSR routes (no DB), then /api/hit alone -
 *      memory is RSS-sampled between each so the DB route's contribution to
 *      growth can be seen separately. Prisma's driver-adapter engine is a
 *      wasm-bindgen module, and edgejs is known to leak memory across the
 *      externref boundary that crosses (see loadtest/nextjs/README.md).
 *
 * Requires `docker` on PATH, in addition to nextjs-load-test.ts's
 * requirements.
 *
 * Run `pnpm run loadtest:nextjs:local --help` for CLI details.
 */

import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { writeFile } from "node:fs/promises";

import { execa } from "execa";
import * as toml from "@iarna/toml";
import tcpPortUsed from "tcp-port-used";

import { copyPackageAnonymous } from "../../src/package";
import { pollUntil } from "../../src/util";
import {
  DB_ROUTE,
  DEFAULT_CONCURRENCY,
  DEFAULT_COUNT,
  FIXTURE_DIR,
  positiveInteger,
  routeCount,
  routePaths,
  runArtillery,
} from "./shared";

const NEXT_BUNDLE_DIR = ".next-bundle";
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 250;
const POSTGRES_IMAGE = "postgres:16-alpine";
const POSTGRES_PASSWORD = "postgres";
const POSTGRES_DB = "blogloadtest";

interface ParsedArguments {
  help?: boolean;
  concurrency?: string;
  count?: string;
  dbCount?: string;
}

function parseArguments(args: string[]): ParsedArguments {
  let concurrency: string | undefined;
  let count: string | undefined;
  let dbCount: string | undefined;

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
      case "--db-count":
        dbCount = value;
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  return { concurrency, count, dbCount };
}

function printUsage(): void {
  console.info(`Usage: nextjs-load-test-local.ts [options]

Builds fixtures/nextjs/blog-load-test, runs it locally with \`wasmer run\`,
load-tests the ${routeCount()} plain SSR routes, then load-tests the
Prisma-backed ${DB_ROUTE} route alone, reporting the process's resident
memory (RSS) after each phase. Requires \`docker\` on PATH.

Options:
  --concurrency <number>   Concurrent Artillery virtual users (default: ${DEFAULT_CONCURRENCY})
  --count <number>         Times each virtual user loads every SSR route (default: ${DEFAULT_COUNT})
  --db-count <number>      Times each virtual user loads ${DB_ROUTE} (default: same as --count).
                           Separate from --count since the SSR phase has ${routeCount()}x
                           as many routes, so reaching "thousands" of DB
                           requests would otherwise force a disproportionately
                           large SSR run too.
  -h, --help               Show this help message`);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to determine a free port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function readRssKb(pid: number): Promise<number> {
  const { stdout } = await execa("ps", ["-o", "rss=", "-p", String(pid)]);
  const rss = Number(stdout.trim());
  if (!Number.isFinite(rss)) {
    throw new Error(`Could not parse RSS from ps output: '${stdout}'`);
  }
  return rss;
}

function formatMb(rssKb: number): string {
  return `${(rssKb / 1024).toFixed(1)} MB`;
}

interface Postgres {
  containerName: string;
  databaseUrl: string;
}

async function startPostgres(): Promise<Postgres> {
  const containerName = `nextjs-load-test-pg-${crypto.randomUUID().slice(0, 8)}`;
  const port = await getFreePort();
  const databaseUrl = `postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}`;

  console.info(`Starting Postgres container ${containerName} on port ${port}`);
  await execa("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    containerName,
    "-e",
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    "-e",
    `POSTGRES_DB=${POSTGRES_DB}`,
    "-p",
    `${port}:5432`,
    POSTGRES_IMAGE,
  ]);

  await pollUntil(
    async () => {
      const result = await execa(
        "docker",
        ["exec", containerName, "pg_isready", "-U", "postgres"],
        { reject: false },
      );
      return result.exitCode === 0 || undefined;
    },
    {
      timeoutMs: READY_TIMEOUT_MS,
      intervalMs: READY_POLL_INTERVAL_MS,
      description: `Postgres container ${containerName} to become ready`,
    },
  );

  return { containerName, databaseUrl };
}

async function stopPostgres(containerName: string): Promise<void> {
  await execa("docker", ["stop", containerName], { reject: false });
}

async function writeWasmerToml(workDir: string): Promise<void> {
  const contents = toml.stringify({
    dependencies: {
      // Unpinned: this tool is meant to reflect whatever edgejs-quickjs is
      // currently published, not freeze a historical version.
      "wasmer/edgejs-quickjs": "*",
    },
    fs: {
      "/app": NEXT_BUNDLE_DIR,
    },
    command: [
      {
        name: "run",
        module: "wasmer/edgejs-quickjs:edge",
        runner: "https://webc.org/runner/wasi",
        annotations: {
          wasi: {
            "main-args": ["/app/server.mjs"],
          },
        },
      },
    ],
  });
  await writeFile(path.join(workDir, "wasmer.toml"), contents);
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
  const dbCount = positiveInteger("--db-count", options.dbCount, count);

  const workDir = await copyPackageAnonymous(FIXTURE_DIR);
  console.info(`Building ${workDir}`);

  const postgres = await startPostgres();
  try {
    const dbEnv = { ...process.env, DATABASE_URL: postgres.databaseUrl };

    await execa("pnpm", ["install"], { cwd: workDir, stdio: "inherit" });
    await execa("pnpm", ["exec", "prisma", "db", "push"], {
      cwd: workDir,
      env: dbEnv,
      stdio: "inherit",
    });
    await execa("pnpm", ["exec", "prisma", "generate"], {
      cwd: workDir,
      env: dbEnv,
      stdio: "inherit",
    });
    await execa(
      "pnpm",
      [
        "dlx",
        "next-bundle@1.0.0",
        "--project-root",
        workDir,
        "--build-command",
        "pnpm run build",
      ],
      { cwd: workDir, stdio: "inherit" },
    );
    await writeWasmerToml(workDir);

    const port = await getFreePort();
    const wasmerBinary = process.env.WASMER_PATH ?? "wasmer";

    console.info(`Starting ${wasmerBinary} run . --net on port ${port}`);
    const subprocess = execa(
      wasmerBinary,
      [
        "run",
        ".",
        "--net",
        "--env",
        `PORT=${port}`,
        "--env",
        "HOST=127.0.0.1",
        "--env",
        `DATABASE_URL=${postgres.databaseUrl}`,
      ],
      { cwd: workDir, stdio: "inherit", reject: false },
    );
    // We manage this process's lifetime manually (kill it in `finally`), so
    // suppress the unhandled-rejection warning that would otherwise fire the
    // moment we kill it - `reject: false` above means it resolves instead of
    // rejecting on a non-zero/signal exit anyway.
    subprocess.catch(() => {});

    try {
      await tcpPortUsed.waitUntilUsed(
        port,
        READY_POLL_INTERVAL_MS,
        READY_TIMEOUT_MS,
      );

      const target = new URL(`http://127.0.0.1:${port}`);
      const verifyResponse = await fetch(target);
      if (!verifyResponse.ok) {
        throw new Error(
          `Fixture did not serve successfully: status ${verifyResponse.status}`,
        );
      }
      console.info(
        `Verified ${target} is serving (status ${verifyResponse.status})`,
      );

      const pid = subprocess.pid;
      if (!pid) {
        throw new Error("wasmer run did not report a pid");
      }

      const rssBaselineKb = await readRssKb(pid);
      console.info(
        `Memory baseline:               ${formatMb(rssBaselineKb)} (RSS)`,
      );

      await runArtillery(
        routePaths(),
        concurrency,
        count,
        target,
        "Plain SSR routes (no DB)",
      );
      const rssAfterSsrKb = await readRssKb(pid);
      console.info(
        `Memory after plain-SSR load:   ${formatMb(rssAfterSsrKb)} (RSS)  [delta ${formatMb(rssAfterSsrKb - rssBaselineKb)}]`,
      );

      await runArtillery(
        [DB_ROUTE],
        concurrency,
        dbCount,
        target,
        "Prisma /api/hit (wasm-bindgen query per request)",
      );
      const rssAfterDbKb = await readRssKb(pid);
      console.info(
        `Memory after Prisma-route load: ${formatMb(rssAfterDbKb)} (RSS)  [delta ${formatMb(rssAfterDbKb - rssAfterSsrKb)}]`,
      );
    } finally {
      subprocess.kill("SIGTERM");
      await subprocess;
    }
  } finally {
    await stopPostgres(postgres.containerName);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
