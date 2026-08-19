// `ass up`: build local state and stop. Load+validate → resolve platform
// (reuse a live one; never tear down a pre-existing run — reseeding is
// seconds, boots are minutes, spec §5) → local-only guard → D-I held-state
// reconciliation → seeders in spec §3.1 order, each emitted entry flushed
// before the creating call returns → seed line + held summary. A failure
// after the descriptor exists exits 4 and names the exact recovery command.

import path from "node:path";
import process from "node:process";
import { LocalPlatformDriver } from "../fixtures/localPlatform";
import { EXIT_OK, EXIT_SETUP_FAILED, EXIT_USAGE } from "../engine/assessment";
import {
  digestDeclaration,
  listHeldDescriptors,
  releaseHeldDescriptor,
  writeHeldDescriptor,
  type HeldDescriptor,
} from "./descriptor";
import { loadDeclarationFile, SimulatorLoadError } from "./schema";
import { assertLocalOnly, GuardRefusalError } from "./guard";
import { resolvePlatform } from "./platform";
import {
  builtinSeeders,
  builtinTeardownKinds,
  SeedPlanError,
  type CorrelationIds,
  type SeedContext,
  type Seeder,
  type SimulatorIo,
} from "./registry";
import { replayDataEntries } from "./down";
import { resolveSeed, seededRandom, seedLine } from "./random";
import type { SimulatorDeps } from "./deps";
import { acquireHeldLock, HeldLockError } from "./lock";

export interface UpOptions {
  file: string;
  /** Repeatable `--set path=value` tweaks applied over the file. */
  set?: string[];
  plan?: boolean;
  verbose?: boolean;
  cwd: string;
  io: SimulatorIo;
  deps?: SimulatorDeps;
}

function seedersFor(
  seeders: Seeder[],
  declaration: {
    apps?: unknown;
    telemetry?: unknown;
    billing?: unknown;
  },
): Seeder[] {
  return seeders.filter(
    (seeder) =>
      seeder.block === "account" || declaration[seeder.block] !== undefined,
  );
}

export async function runUp(options: UpOptions): Promise<number> {
  const { io } = options;
  const verbose = options.verbose === true;
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
  const seeders = seedersFor(
    options.deps?.seeders ?? (await builtinSeeders()),
    declaration,
  );

  if (options.plan === true) {
    io.out(`plan: ${declaration.name} (${loaded.path})`);
    io.out(seedLine(seed));
    try {
      for (const seeder of seeders) {
        for (const line of seeder.plan(declaration, {
          seed,
          random: seededRandom(seed),
        })) {
          io.out(`  ${line}`);
        }
      }
    } catch (err) {
      if (err instanceof SeedPlanError) {
        io.err(`error: ${err.message}`);
        return EXIT_USAGE;
      }
      throw err;
    }
    io.out("plan only — nothing was written");
    return EXIT_OK;
  }

  const driver =
    options.deps?.driver ??
    new LocalPlatformDriver(options.cwd, {
      io: { info: (line) => io.err(line) },
      onLine: verbose ? (line) => io.err(`  ${line}`) : undefined,
    });
  const repoDir = driver.repoDir;

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

  let descriptorWritten = false;
  try {
    let platform;
    try {
      platform = await resolvePlatform(
        driver,
        { info: (line) => io.err(line) },
        options.deps?.fetchImpl,
      );
    } catch (err) {
      io.err(
        `error: platform boot failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      io.err("nothing was seeded; no held state was created");
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

    // D-I: one held scenario per platform. Same slug + same digest + a
    // completed seed is a cheap no-op; anything else tears down the previous
    // scenario's *data* (platform kept) before seeding.
    const digest = digestDeclaration(loaded.raw);
    const listing = listHeldDescriptors(repoDir);
    if (listing.corrupt.length > 0) {
      for (const corrupt of listing.corrupt) {
        io.err(`error: ${corrupt.error}`);
      }
      return EXIT_USAGE;
    }
    let ownsPlatform = platform.booted;
    for (const previous of listing.descriptors) {
      const teardownBegun = previous.teardown.some(
        (entry) => entry.done === true,
      );
      if (
        previous.slug === declaration.name &&
        previous.declarationDigest === digest &&
        previous.completedAt !== null &&
        !teardownBegun
      ) {
        io.out(
          `already seeded: ${previous.slug} (seed ${previous.seed}) — ` +
            "declaration unchanged, nothing to do",
        );
        io.out(seedLine(previous.seed));
        return EXIT_OK;
      }
      // Additive delta (trial-2 option B): a pure per-app surge on the
      // held world inserts only the extra rows — seconds instead of a
      // rebuild. Anything unprovable falls through to the full path.
      if (
        previous.slug === declaration.name &&
        previous.completedAt !== null &&
        !teardownBegun &&
        previous.declaration !== undefined
      ) {
        const { classifyDelta, applyTelemetryDelta } = await import("./delta");
        const classified = classifyDelta(previous.declaration, declaration);
        if (classified.kind === "surge") {
          io.err(
            `delta seed: only rps.perApp increased (` +
              Object.entries(classified.surged)
                .map(([name, [from, to]]) => `${name} ×${from}→×${to}`)
                .join(", ") +
              ") — inserting the surge without a rebuild",
          );
          try {
            const started = Date.now();
            const result = await applyTelemetryDelta({
              env: platform.env,
              descriptor: previous,
              next: declaration,
              io,
            });
            const chEntry = previous.teardown.find(
              (entry) => entry.kind === "clickhouse-rows",
            );
            if (chEntry !== undefined) {
              chEntry["totalRequests"] = result.totalRequests;
              chEntry["projectedDaily"] = result.projectedDaily;
            }
            previous.declaration = declaration;
            previous.declarationDigest = digest;
            previous.overrides = loaded.overrides;
            previous.scenarioPath = filePath;
            previous.completedAt = new Date(
              (options.deps?.now ?? (() => Date.now()))(),
            ).toISOString();
            writeHeldDescriptor(repoDir, previous);
            io.out(
              `delta seeded: +${result.addedRequests.toLocaleString()} ` +
                `requests (${result.perApp
                  .map((app) => app.name)
                  .join(
                    ", ",
                  )}) in ${((Date.now() - started) / 1000).toFixed(1)}s — world total now ` +
                result.totalRequests.toLocaleString(),
            );
            io.out(seedLine(previous.seed));
            return EXIT_OK;
          } catch (err) {
            io.err(
              `delta seed unavailable (${err instanceof Error ? err.message : String(err)}) — falling back to a full rebuild`,
            );
          }
        }
      }
      io.err(
        `held scenario "${previous.slug}" ` +
          (previous.slug === declaration.name
            ? "has a changed declaration"
            : "is being replaced") +
          " — tearing down its data first (platform stays up)",
      );
      const errors = await replayDataEntries(previous, {
        repoDir,
        env: platform.env,
        driver,
        io,
        verbose,
        kinds: options.deps?.teardownKinds ?? (await builtinTeardownKinds()),
      });
      if (errors.length > 0) {
        for (const error of errors) {
          io.err(`error: ${error}`);
        }
        io.err(
          `previous scenario "${previous.slug}" did not tear down cleanly; ` +
            `its descriptor is kept — run \`ass down ${previous.slug}\` ` +
            "and retry",
        );
        return EXIT_SETUP_FAILED;
      }
      // The platform outlives the swap, so ownership transfers to the new
      // held state rather than evaporating with the old descriptor.
      ownsPlatform = ownsPlatform || previous.ownsPlatform;
      releaseHeldDescriptor(repoDir, previous.slug);
    }

    const now = options.deps?.now ?? (() => Date.now());
    const descriptor: HeldDescriptor = {
      slug: declaration.name,
      mode: "up",
      assSchema: declaration.assSchema,
      scenarioPath: filePath,
      seed,
      declarationDigest: digest,
      heldAt: new Date(now()).toISOString(),
      completedAt: null,
      ownsPlatform,
      overrides: loaded.overrides,
      declaration,
      teardown: [],
    };
    writeHeldDescriptor(repoDir, descriptor);
    descriptorWritten = true;

    const ids: CorrelationIds = { apps: [] };
    const ctx: SeedContext = {
      repoDir,
      env: platform.env,
      seed,
      random: seededRandom(seed),
      io,
      verbose,
      ids,
    };
    for (const seeder of seeders) {
      io.err(`seeding ${seeder.block}…`);
      await seeder.apply(declaration, ctx, (entry) => {
        descriptor.teardown.push({ done: false, ...entry });
        writeHeldDescriptor(repoDir, descriptor);
      });
    }

    descriptor.completedAt = new Date(now()).toISOString();
    writeHeldDescriptor(repoDir, descriptor);

    if (generated) {
      io.out(seedLine(seed));
    }
    io.out(
      `held: ${declaration.name} — ${descriptor.teardown.length} teardown ` +
        `entr${descriptor.teardown.length === 1 ? "y" : "ies"} recorded in ` +
        `${path.relative(process.cwd(), path.join(repoDir, ".ass", "state", `${declaration.name}.held.json`))}`,
    );
    if (!generated) {
      io.out(seedLine(seed));
    }
    io.out(`release with: ass down --file ${options.file}`);
    return EXIT_OK;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    io.err(`error: seeding failed: ${detail}`);
    if (descriptorWritten) {
      io.err(
        "everything created so far is recorded in the held descriptor; " +
          `recover with: ass down --file ${options.file}`,
      );
    }
    return EXIT_SETUP_FAILED;
  } finally {
    releaseLock();
  }
}
