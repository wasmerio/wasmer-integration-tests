// The v2 verbs: `up` (reconcile to the declaration), `diff` (plan only),
// `verify` (plan must be empty), `down` (reconcile to the empty set).
// All four are the same loop; only the desired set and the exactness
// differ, which is the whole point of the design.

import path from "node:path";
import {
  LocalPlatformDriver,
  type PlatformDriver,
} from "../../fixtures/localPlatform";
import {
  EXIT_OK,
  EXIT_SETUP_FAILED,
  EXIT_USAGE,
} from "../../engine/assessment";
import { assertLocalOnly, GuardRefusalError } from "../guard";
import { platformIsLive, resolvePlatform, type FetchLike } from "../platform";
import { acquireHeldLock, HeldLockError } from "../lock";
import { SimulatorLoadError } from "../schema";
import { resolveSeed, seedLine } from "../random";
import { loadDeclarationFile } from "./scenario";
import { buildWorld, summarizeExpansion, ExpansionError } from "./expand";
import { builtinAdapters } from "./engine/registry";
import {
  closeContext,
  createContext,
  resolveWorkers,
  type SimulatorIo,
} from "./engine/context";
import { planReconciliation, rawFromOf, reconcile } from "./engine/reconcile";
import { animationSink, ReconcileReporter } from "./render";
import {
  digestDeclaration,
  digestsFromLedger,
  identityFromLedger,
  rawFromLedger,
  isV1Hold,
  ledgerPath,
  readLedger,
  writeLedger,
  type LedgerFile,
} from "./ledger";
import { unlinkSync } from "node:fs";
import os from "node:os";

export interface VerbOptions {
  file?: string;
  slug?: string;
  set?: string[];
  plan?: boolean;
  exact?: boolean;
  verify?: boolean;
  verbose?: boolean;
  anchor?: string;
  workers?: number;
  workersSdk?: number;
  workersClickhouse?: number;
  workersPostgres?: number;
  cwd: string;
  io: SimulatorIo;
  /** Whether the sink accepts ANSI (the CLI decides; NO_COLOR honoured). */
  color?: boolean;
  /** Test seam: fake the platform driver / liveness probe. */
  deps?: {
    driver?: PlatformDriver;
    fetchImpl?: FetchLike;
  };
}

function reporterFor(options: VerbOptions): ReconcileReporter {
  return new ReconcileReporter({
    io: options.io,
    color: options.color,
    verbose: options.verbose,
    animate: animationSink(),
  });
}

function driverFor(options: VerbOptions): PlatformDriver {
  return (
    options.deps?.driver ??
    new LocalPlatformDriver(options.cwd, {
      io: { info: (line) => options.io.err(line) },
    })
  );
}

function widthsOf(options: VerbOptions): ReturnType<typeof resolveWorkers> {
  return resolveWorkers(
    {
      workers: options.workers,
      workersSdk: options.workersSdk,
      workersClickhouse: options.workersClickhouse,
      workersPostgres: options.workersPostgres,
    },
    process.env,
    os.cpus().length,
  );
}

function anchorOf(options: VerbOptions): number {
  if (options.anchor === undefined) {
    return Date.now();
  }
  const parsed = Date.parse(options.anchor);
  if (Number.isNaN(parsed)) {
    throw new SimulatorLoadError(
      `--anchor is not an ISO timestamp: "${options.anchor}"`,
    );
  }
  return parsed;
}

export async function runUpV2(options: VerbOptions): Promise<number> {
  const { io } = options;
  const reporter = reporterFor(options);
  if (options.file === undefined) {
    io.err("error: ass up requires --file");
    return EXIT_USAGE;
  }
  const filePath = path.resolve(options.cwd, options.file);
  let loaded;
  try {
    loaded = loadDeclarationFile(filePath, options.set ?? []);
  } catch (err) {
    if (err instanceof SimulatorLoadError) {
      io.err(`error: ${err.message}`);
      return EXIT_USAGE;
    }
    throw err;
  }
  const declaration = loaded.declaration;
  const { seed, generated } = resolveSeed(declaration.seed);
  const world = buildWorld({ declaration, seed, anchorMs: anchorOf(options) });

  let summary;
  try {
    summary = summarizeExpansion(world);
  } catch (err) {
    if (err instanceof ExpansionError || err instanceof Error) {
      io.err(`error: ${err.message}`);
      return EXIT_USAGE;
    }
    throw err;
  }
  if (options.plan === true) {
    reporter.banner(
      declaration.name,
      `plan ${path.relative(options.cwd, loaded.path)}`,
    );
    reporter.step("expansion", [["seed", String(seed)]]);
    for (const line of summary.lines) {
      reporter.note(line);
    }
  }

  const driver = driverFor(options);
  const repoDir = driver.repoDir;

  if (options.plan === true) {
    // `--plan` prints the expansion with no platform at all; the plan
    // itself needs one, so it is printed by the normal path instead.
    reporter.note("plan only - nothing was written");
    reporter.close();
    return EXIT_OK;
  }

  let releaseLock: () => void;
  try {
    releaseLock = acquireHeldLock(repoDir);
  } catch (err) {
    if (err instanceof HeldLockError) {
      io.err(`error: ${err.message}`);
      return EXIT_USAGE;
    }
    throw err;
  }

  try {
    reporter.banner(
      declaration.name,
      `reconcile ${path.relative(options.cwd, loaded.path)}`,
    );
    reporter.step("platform", "resolving the local platform");
    let platform;
    try {
      platform = await resolvePlatform(
        driver,
        // The driver's lines (and the platform boot's, which can run for
        // minutes) are quoted inside the frame like any chained program.
        { info: (line) => reporter.child(line) },
        options.deps?.fetchImpl,
      );
    } catch (err) {
      reporter.error(
        `platform boot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      reporter.note(
        "nothing was reconciled; no held state was created or changed",
      );
      reporter.close();
      return EXIT_SETUP_FAILED;
    }
    try {
      assertLocalOnly(platform.env);
    } catch (err) {
      if (err instanceof GuardRefusalError) {
        io.err(`error: ${err.message}`);
        return EXIT_USAGE;
      }
      throw err;
    }
    reporter.note(
      platform.booted
        ? "booted a local platform for this reconcile"
        : "reusing the running local platform",
    );

    // Q-B: a v1 world is rebuilt once rather than adopted. It is local and
    // disposable, and backfilling markers would be a migration nobody can
    // verify.
    if (isV1Hold(repoDir, declaration.name)) {
      reporter.step(
        "migrate",
        `v1 hold found - tearing it down once before reconciling`,
      );
      const { runDown } = await import("../down");
      const code = await runDown({
        slug: declaration.name,
        cwd: options.cwd,
        io,
        verbose: options.verbose,
      });
      if (code !== EXIT_OK) {
        reporter.error(
          "the v1 teardown did not complete; re-run `ass down` and retry",
        );
        reporter.close();
        return EXIT_SETUP_FAILED;
      }
    }

    const ledger = readLedger(repoDir, declaration.name);
    const workers = widthsOf(options);
    const ctx = createContext({
      env: platform.env,
      io,
      verbose: options.verbose === true,
      workers,
      identity: identityFromLedger(ledger),
      scenario: declaration.name,
      credentials: {
        username: declaration.account.username,
        password: declaration.account.password,
      },
    });
    const started = Date.now();
    try {
      const adapters = await builtinAdapters();
      const { result, report } = await reconcile({
        world,
        ctx,
        adapters,
        exact: options.exact === true,
        previousDigests: digestsFromLedger(ledger),
        previousRawFrom: rawFromLedger(ledger),
        onPlan: (plan) => {
          reporter.plan(plan);
          if (plan.operations.length > 0) {
            reporter.apply(workers);
          }
        },
        onKindComplete: (event) => reporter.applied(event),
        verify: options.verify === true,
      });
      const elapsedMs = Date.now() - started;
      if (report !== null && report.errors.length > 0) {
        for (const error of report.errors) {
          reporter.error(error);
        }
        reporter.note(
          "the world is between observed and desired; the next `ass up` observes it and converges",
        );
        reporter.close();
        return EXIT_SETUP_FAILED;
      }
      writeLedger(
        repoDir,
        buildLedger({
          world,
          loaded,
          seed,
          ownsPlatform: platform.booted || (ledger?.ownsPlatform ?? false),
          workers,
          counts: summary.counts,
          digests: result.desiredDigests,
          identity: ctx.identity.toJSON(),
          summary,
        }),
      );
      if (generated) {
        reporter.note(seedLine(seed));
      }
      reporter.summary({
        slug: declaration.name,
        outcome:
          result.plan.operations.length === 0 ? "converged" : "reconciled",
        operations: result.plan.operations.length,
        totalMs: elapsedMs,
        observeMs: result.observeMs,
        signIn: {
          dashboard:
            platform.env["SM_DASHBOARD_BASE_URL"] ?? "http://localhost:8082",
          username: world.username,
          password: world.password,
          namespace: world.namespace,
        },
      });
      return EXIT_OK;
    } finally {
      await closeContext(ctx);
    }
  } catch (err) {
    io.err(
      `error: reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return EXIT_SETUP_FAILED;
  } finally {
    releaseLock();
  }
}

function buildLedger(input: {
  world: ReturnType<typeof buildWorld>;
  loaded: ReturnType<typeof loadDeclarationFile>;
  seed: number;
  ownsPlatform: boolean;
  workers: ReturnType<typeof resolveWorkers>;
  counts: Record<string, number>;
  digests: Map<string, string>;
  identity: Array<{ key: string; native: Record<string, string | number> }>;
  summary: ReturnType<typeof summarizeExpansion>;
}): LedgerFile {
  const now = new Date().toISOString();
  const daily = (input.world.traffic?.daily ?? []).map((day) => ({
    date: day.date,
    requests: day.requests,
    http5xx: day.http5xx,
  }));
  return {
    stateVersion: 2,
    engine: "v2",
    slug: input.world.scenario,
    mode: "up",
    assSchema: 2,
    scenarioPath: input.loaded.path,
    seed: input.seed,
    declarationDigest: digestDeclaration(input.loaded.raw),
    heldAt: now,
    completedAt: now,
    ownsPlatform: input.ownsPlatform,
    overrides: input.loaded.overrides,
    declaration: input.loaded.declaration,
    anchorMs: input.world.anchorMs,
    workers: { ...input.workers },
    perKindCounts: input.counts,
    digests: Object.fromEntries(input.digests),
    rawFrom: rawFromOf(input.world),
    identity: input.identity,
    surface: {
      apps: input.world.apps.length,
      totalRequests: input.summary.totalRequests,
      daily,
    },
    teardown: [],
  };
}

export async function runDiffV2(
  options: VerbOptions & { verifyMode?: boolean },
): Promise<number> {
  const { io } = options;
  if (options.file === undefined) {
    io.err("error: ass diff requires --file");
    return EXIT_USAGE;
  }
  let loaded;
  try {
    loaded = loadDeclarationFile(
      path.resolve(options.cwd, options.file),
      options.set ?? [],
    );
  } catch (err) {
    if (err instanceof SimulatorLoadError) {
      io.err(`error: ${err.message}`);
      return EXIT_USAGE;
    }
    throw err;
  }
  const declaration = loaded.declaration;
  const { seed } = resolveSeed(declaration.seed);
  const driver = driverFor(options);
  const repoDir = driver.repoDir;
  const reporter = reporterFor(options);
  const ledger = readLedger(repoDir, declaration.name);
  const world = buildWorld({
    declaration,
    seed,
    // A diff against a held world uses the world's anchor, so "unchanged"
    // means unchanged rather than "an hour has passed".
    anchorMs:
      options.anchor !== undefined
        ? anchorOf(options)
        : (ledger?.anchorMs ?? Date.now()),
  });

  // A plan is a read: it never boots a platform (booting one to answer
  // "what would change?" would cost minutes). With none serving, the
  // expansion is still worth printing - it is the declaration half's whole
  // output and needs no infrastructure.
  const env = await platformIsLive(driver, options.deps?.fetchImpl);
  if (env === null) {
    reporter.banner(
      declaration.name,
      options.verifyMode === true ? "verify" : "diff",
    );
    reporter.step("expansion", "no live local platform");
    reporter.note("printing the expansion only; nothing was observed");
    for (const line of summarizeExpansion(world).lines) {
      reporter.note(line);
    }
    if (options.verifyMode === true) {
      reporter.error("there is no platform to verify against");
      reporter.close();
      return EXIT_SETUP_FAILED;
    }
    reporter.close();
    return EXIT_OK;
  }
  try {
    assertLocalOnly(env);
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_USAGE;
  }
  const ctx = createContext({
    env,
    io,
    verbose: options.verbose === true,
    workers: widthsOf(options),
    identity: identityFromLedger(ledger),
    scenario: declaration.name,
    credentials: {
      username: declaration.account.username,
      password: declaration.account.password,
    },
  });
  try {
    const adapters = await builtinAdapters();
    const result = await planReconciliation({
      world,
      ctx,
      adapters,
      exact: options.exact === true,
      previousDigests: digestsFromLedger(ledger),
      previousRawFrom: rawFromLedger(ledger),
    });
    reporter.banner(
      declaration.name,
      options.verifyMode === true ? "verify" : "diff",
    );
    reporter.plan(result.plan);
    reporter.summary({
      slug: declaration.name,
      // `diff` writes nothing: a non-empty plan is drift, not a reconcile.
      outcome: result.plan.operations.length === 0 ? "converged" : "drifted",
      operations: result.plan.operations.length,
      totalMs: result.observeMs + result.diffMs,
      observeMs: result.observeMs,
      diffMs: result.diffMs,
      drilled: result.drill.size,
    });
    if (options.verifyMode === true && result.plan.operations.length > 0) {
      reporter.error(
        "the plan is not empty - the world does not match the declaration",
      );
      reporter.close();
      return EXIT_SETUP_FAILED;
    }
    if (
      options.verifyMode === true &&
      options.exact === true &&
      result.plan.surplus.length > 0
    ) {
      reporter.error(
        `${result.plan.surplus.length} bucket(s) hold surplus (--exact)`,
      );
      reporter.close();
      return EXIT_SETUP_FAILED;
    }
    return EXIT_OK;
  } finally {
    await closeContext(ctx);
  }
}

export async function runDownV2(options: VerbOptions): Promise<number> {
  const { io } = options;
  const driver = driverFor(options);
  const repoDir = driver.repoDir;
  const reporter = reporterFor(options);
  const slug = options.slug;
  if (slug === undefined) {
    io.err("error: ass down requires a slug (or --file)");
    return EXIT_USAGE;
  }
  const ledger = readLedger(repoDir, slug);
  if (ledger === null) {
    reporter.banner(slug, "release");
    reporter.step(
      "released",
      "nothing held for this scenario under the v2 engine",
    );
    reporter.close();
    return EXIT_OK;
  }
  const world = buildWorld({
    declaration: ledger.declaration,
    seed: ledger.seed,
    anchorMs: ledger.anchorMs,
  });
  // Teardown never boots a platform. `make local-dev-down` destroys the
  // stack and *then* releases held scenarios, so a dead platform is the
  // normal case here: the data went with the volumes and there is nothing
  // left to reconcile against.
  const env = await platformIsLive(driver, options.deps?.fetchImpl);
  if (env === null) {
    reporter.banner(slug, "release");
    reporter.step("released", "platform is not serving");
    reporter.note(
      "its data (and volumes) are already gone; releasing the held state",
    );
    if (ledger.ownsPlatform) {
      reporter.note(
        "if platform containers linger, `make local-platform-down` clears them",
      );
    }
    unlinkSync(ledgerPath(repoDir, slug));
    reporter.close();
    return EXIT_OK;
  }
  try {
    assertLocalOnly(env);
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_USAGE;
  }
  const ctx = createContext({
    env,
    io,
    verbose: options.verbose === true,
    workers: widthsOf(options),
    identity: identityFromLedger(ledger),
    scenario: slug,
    credentials: {
      username: ledger.declaration.account.username,
      password: ledger.declaration.account.password,
    },
  });
  try {
    const adapters = await builtinAdapters();
    reporter.banner(slug, "release");
    const started = Date.now();
    const { result, report } = await reconcile({
      world,
      ctx,
      adapters,
      // Teardown is two-sided by definition: the desired set is empty, so
      // everything the simulator owns is surplus and must go.
      exact: true,
      toEmpty: true,
      previousDigests: digestsFromLedger(ledger),
      previousRawFrom: rawFromLedger(ledger),
      onPlan: (plan) => {
        reporter.plan(plan);
        if (plan.operations.length > 0) {
          reporter.apply(widthsOf(options));
        }
      },
      onKindComplete: (event) => reporter.applied(event),
    });
    if (report !== null && report.errors.length > 0) {
      for (const error of report.errors) {
        reporter.error(error);
      }
      reporter.note(
        `the hold for "${slug}" is kept; re-run \`ass down ${slug}\` to converge`,
      );
      reporter.close();
      return EXIT_SETUP_FAILED;
    }
    unlinkSync(ledgerPath(repoDir, slug));
    reporter.summary({
      slug,
      outcome: "released",
      operations: result.plan.operations.length,
      totalMs: Date.now() - started,
      observeMs: result.observeMs,
    });
    if (world.pinned) {
      reporter.note("identity retained: the account is pinned");
    }
    return EXIT_OK;
  } catch (err) {
    io.err(
      `error: teardown failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    io.err(
      `the hold for "${slug}" is kept; re-run \`ass down ${slug}\` to converge`,
    );
    return EXIT_SETUP_FAILED;
  } finally {
    await closeContext(ctx);
  }
}
