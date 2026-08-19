// `ass down`: replay the held descriptor's entries in reverse creation
// order, checkpointing `done` after each so a partial teardown resumes
// instead of restarting (worklog "teardown correctness model"). D-J: a
// --file argument only locates the slug; the descriptor is the truth. When
// the platform is not serving, every datastore entry is satisfied by volume
// death and the descriptor is released without touching anything.

import path from "node:path";
import { load as parseYaml } from "js-yaml";
import { readFileSync } from "node:fs";
import {
  LocalPlatformDriver,
  type PlatformDriver,
} from "../fixtures/localPlatform";
import { EXIT_OK, EXIT_SETUP_FAILED, EXIT_USAGE } from "../engine/assessment";
import {
  CorruptDescriptorError,
  digestDeclaration,
  listHeldDescriptors,
  readHeldDescriptor,
  releaseHeldDescriptor,
  writeHeldDescriptor,
  type HeldDescriptor,
} from "./descriptor";
import { assertLocalOnly, GuardRefusalError } from "./guard";
import { platformIsLive } from "./platform";
import {
  builtinTeardownKinds,
  resolveTeardownKind,
  type SimulatorIo,
  type TeardownKind,
} from "./registry";
import type { SimulatorDeps } from "./deps";

export interface DownOptions {
  file?: string;
  slug?: string;
  verbose?: boolean;
  cwd: string;
  io: SimulatorIo;
  deps?: SimulatorDeps;
}

interface ReplayContext {
  repoDir: string;
  env: Record<string, string>;
  driver: PlatformDriver;
  io: SimulatorIo;
  verbose: boolean;
  kinds: TeardownKind[];
}

/** Replay every *data* entry (everything but the platform itself) in
 * reverse creation order. Flushes `done` per entry; returns accumulated
 * errors. Shared by `down` and the D-I scenario-switch path in `up`. */
export async function replayDataEntries(
  descriptor: HeldDescriptor,
  ctx: ReplayContext,
): Promise<string[]> {
  const errors: string[] = [];
  for (const entry of [...descriptor.teardown].reverse()) {
    if (entry.done === true) {
      continue;
    }
    const kind = resolveTeardownKind(ctx.kinds, entry.kind);
    if (kind === null) {
      errors.push(
        `unknown teardown kind "${entry.kind}" — the descriptor was ` +
          "written by a newer ass build than this one",
      );
      continue;
    }
    if (ctx.verbose) {
      ctx.io.err(`tearing down ${entry.kind}…`);
    }
    const entryErrors = await kind.down(entry, {
      repoDir: ctx.repoDir,
      env: ctx.env,
      driver: ctx.driver,
      io: ctx.io,
      verbose: ctx.verbose,
    });
    if (entryErrors.length > 0) {
      errors.push(...entryErrors);
      continue;
    }
    entry.done = true;
    writeHeldDescriptor(ctx.repoDir, descriptor);
  }
  return errors;
}

function slugFromFile(
  cwd: string,
  file: string,
  io: SimulatorIo,
): string | null {
  const filePath = path.resolve(cwd, file);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    io.err(
      `error: cannot read ${filePath}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  let name: unknown;
  try {
    const data = parseYaml(raw);
    name = (data as Record<string, unknown> | null)?.["name"];
  } catch {
    name = undefined;
  }
  if (typeof name !== "string" || name === "") {
    io.err(
      `error: ${filePath} has no readable \`name\` key — cannot locate the ` +
        "held slug. Pass the slug directly: ass down <slug>",
    );
    return null;
  }
  return name;
}

export async function runDown(options: DownOptions): Promise<number> {
  const { io } = options;
  const verbose = options.verbose === true;
  const driver =
    options.deps?.driver ??
    new LocalPlatformDriver(options.cwd, {
      io: { info: (line) => io.err(line) },
      onLine: verbose ? (line) => io.err(`  ${line}`) : undefined,
    });
  const repoDir = driver.repoDir;

  let slug: string | null = null;
  let fileRaw: string | null = null;
  if (options.file !== undefined) {
    slug = slugFromFile(options.cwd, options.file, io);
    if (slug === null) {
      return EXIT_USAGE;
    }
    try {
      fileRaw = readFileSync(path.resolve(options.cwd, options.file), "utf8");
    } catch {
      fileRaw = null;
    }
  } else if (options.slug !== undefined) {
    slug = options.slug;
  } else {
    const listing = listHeldDescriptors(repoDir);
    if (listing.corrupt.length > 0) {
      for (const corrupt of listing.corrupt) {
        io.err(`error: ${corrupt.error}`);
      }
      return EXIT_USAGE;
    }
    if (listing.descriptors.length === 0) {
      io.out("nothing is held — no descriptor under .ass/state/");
      return EXIT_OK;
    }
    if (listing.descriptors.length > 1) {
      io.err(
        "error: multiple scenarios are held; name one: " +
          listing.descriptors.map((descriptor) => descriptor.slug).join(", "),
      );
      return EXIT_USAGE;
    }
    slug = listing.descriptors[0].slug;
  }

  let descriptor: HeldDescriptor | null;
  try {
    descriptor = readHeldDescriptor(repoDir, slug);
  } catch (err) {
    if (err instanceof CorruptDescriptorError) {
      io.err(`error: ${err.message}`);
      return EXIT_USAGE;
    }
    throw err;
  }
  if (descriptor === null) {
    io.out(`nothing is held for "${slug}" — already released`);
    return EXIT_OK;
  }

  // D-J: the descriptor records what actually exists; an edited file must
  // not stop its own cleanup.
  if (
    fileRaw !== null &&
    digestDeclaration(fileRaw) !== descriptor.declarationDigest
  ) {
    io.err(
      `warning: ${options.file} has changed since "${slug}" was seeded; ` +
        "proceeding from the descriptor (it records what actually exists)",
    );
  }

  const env = await platformIsLive(driver, options.deps?.fetchImpl);
  if (env === null) {
    io.out(
      "platform is not serving — its data (and volumes) are already gone; " +
        "releasing the held descriptor",
    );
    if (descriptor.ownsPlatform) {
      io.err(
        "note: if platform containers linger, `make local-platform-down` " +
          "clears them",
      );
    }
    releaseHeldDescriptor(repoDir, slug);
    io.out(`released: ${slug}`);
    return EXIT_OK;
  }

  try {
    assertLocalOnly(env);
  } catch (err) {
    if (err instanceof GuardRefusalError) {
      io.err(`error: ${err.message}`);
      return EXIT_USAGE;
    }
    throw err;
  }

  const errors = await replayDataEntries(descriptor, {
    repoDir,
    env,
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
      `teardown incomplete — ${slug}'s descriptor is kept (minus completed ` +
        "entries); re-run `ass down` to resume",
    );
    return EXIT_SETUP_FAILED;
  }

  if (descriptor.ownsPlatform) {
    io.err("this up booted the platform — tearing the stack down");
    const downError = await driver.down();
    if (downError !== null) {
      io.err(`error: ${downError}`);
      io.err(
        `data teardown finished but the platform release failed; ${slug}'s ` +
          "descriptor is kept — re-run `ass down` to retry",
      );
      // Data entries are all done (flushed above); only the platform entry
      // remains, so a re-run goes straight to it.
      return EXIT_SETUP_FAILED;
    }
  }

  releaseHeldDescriptor(repoDir, slug);
  io.out(`released: ${slug} — all recorded state torn down`);
  return EXIT_OK;
}
