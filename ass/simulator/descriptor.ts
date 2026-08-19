// Held-state teardown descriptor (business-simulator-v1 §2.2, worklog D-F,
// D-I): the serialized replacement for ResolvedState.cleanup's in-process
// closure. Entries are appended and flushed as resources are created, so a
// crash mid-seed leaves a descriptor covering everything that exists; `down`
// replays it and checkpoints `done` per entry so a partial teardown resumes.
// Pretty-printed JSON at a stable path — this file is an inspection surface.
// Never contains tokens or passwords; `down` re-reads test-env.sh.

import { createHash } from "node:crypto";
import type { SimulatorDeclaration } from "./schema";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export class CorruptDescriptorError extends Error {
  readonly path: string;

  constructor(filePath: string, detail: string) {
    super(
      `held-state descriptor ${filePath} is corrupt (${detail}); ` +
        "inspect or remove it manually — it will not be treated as absent",
    );
    this.name = "CorruptDescriptorError";
    this.path = filePath;
  }
}

/** One teardown unit, keyed by concrete recorded IDs (D-F). `kind` selects
 * the TeardownKind handler; the rest is handler-owned payload, zod-parsed at
 * down time. */
export type TeardownEntry = {
  kind: string;
  done?: boolean;
} & Record<string, unknown>;

export interface HeldDescriptor {
  slug: string;
  mode: "up";
  assSchema: number;
  scenarioPath: string;
  seed: number;
  declarationDigest: string;
  heldAt: string;
  /** null while `up` is in flight or after a crash; D-I's "all done". */
  completedAt: string | null;
  /** True only when `up` booted the stack itself. */
  ownsPlatform: boolean;
  /** The `--set` overrides this hold was seeded with (canonical). */
  overrides?: Record<string, string>;
  /** The effective (post-override, post-defaults) declaration — the diff
   * base for delta seeding, immune to on-disk file drift. */
  declaration?: SimulatorDeclaration;
  teardown: TeardownEntry[];
}

export function digestDeclaration(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function heldStateDir(repoDir: string): string {
  return path.join(repoDir, ".ass", "state");
}

export function heldFile(repoDir: string, slug: string): string {
  return path.join(heldStateDir(repoDir), `${slug.toLowerCase()}.held.json`);
}

/** Atomic tmp+rename so a reader never observes a half-written descriptor
 * and a crash mid-write never destroys the previous state. */
export function writeHeldDescriptor(
  repoDir: string,
  descriptor: HeldDescriptor,
): string {
  const file = heldFile(repoDir, descriptor.slug);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(descriptor, null, 2) + "\n");
  renameSync(tmp, file);
  return file;
}

function parseDescriptor(filePath: string, raw: string): HeldDescriptor {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new CorruptDescriptorError(
      filePath,
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const record = data as Partial<HeldDescriptor> | null;
  if (
    record === null ||
    typeof record !== "object" ||
    typeof record.slug !== "string" ||
    record.mode !== "up" ||
    !Array.isArray(record.teardown)
  ) {
    throw new CorruptDescriptorError(
      filePath,
      "not a held-state descriptor shape",
    );
  }
  return record as HeldDescriptor;
}

/** null when nothing is held for the slug; corrupt content throws — a
 * descriptor is an orphan ledger, so it must never silently read as absent. */
export function readHeldDescriptor(
  repoDir: string,
  slug: string,
): HeldDescriptor | null {
  const file = heldFile(repoDir, slug);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return parseDescriptor(file, raw);
}

export interface HeldListing {
  descriptors: HeldDescriptor[];
  corrupt: Array<{ path: string; error: string }>;
}

export function listHeldDescriptors(repoDir: string): HeldListing {
  const dir = heldStateDir(repoDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { descriptors: [], corrupt: [] };
  }
  const listing: HeldListing = { descriptors: [], corrupt: [] };
  for (const name of names.sort()) {
    if (!name.endsWith(".held.json")) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      listing.descriptors.push(
        parseDescriptor(file, readFileSync(file, "utf8")),
      );
    } catch (err) {
      listing.corrupt.push({
        path: file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return listing;
}

export function releaseHeldDescriptor(repoDir: string, slug: string): void {
  rmSync(heldFile(repoDir, slug), { force: true });
}
