// The ledger (`.ass/state/<slug>.held.json`, `stateVersion: 2`). It has
// exactly three roles and they must not be confused: an inspection surface,
// a fast path, and a record of the **last declared intent**. It is never a
// record of state - losing it degrades the engine to additive-only plus one
// full OBSERVE, never to a wrong write, and that asymmetry is the rule for
// anything later added to it.
//
// Atomic tmp+rename writes, so a reader never observes a half-written file
// and a crash mid-write never destroys the previous state. Corrupt files
// are loud errors, never treated as absent. Never contains platform tokens
// or datastore passwords.

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Declaration } from "./scenario";
import { IdentityMap } from "./identity";

/** On-disk format discriminator - not a code version. */
export const STATE_VERSION = 2;

export class CorruptStateError extends Error {
  readonly path: string;

  constructor(filePath: string, detail: string) {
    super(
      `held-state file ${filePath} is corrupt (${detail}); ` +
        "inspect or remove it manually — it will not be treated as absent",
    );
    this.name = "CorruptStateError";
    this.path = filePath;
  }
}

export interface LedgerFile {
  stateVersion: 2;
  slug: string;
  mode: "up";
  assSchema: number;
  scenarioPath: string;
  seed: number;
  declarationDigest: string;
  heldAt: string;
  /** null while `up` is in flight or after a crash. */
  completedAt: string | null;
  /** True only when `up` booted the stack itself. */
  ownsPlatform: boolean;
  /** The `--set` overrides this hold was reconciled with (canonical). */
  overrides: Record<string, string>;
  declaration: Declaration;
  /** The anchor of the last reconcile (section 8.2). */
  anchorMs: number;
  /** Effective worker widths, so a timing anomaly is attributable. */
  workers: Record<string, number>;
  perKindCounts: Record<string, number>;
  /** Desired day digests of the last reconcile - the declared-change test
   * of section 7.3. Day-level rather than per-bucket: at enterprise scale
   * per-bucket fingerprints would be ~1.7 M entries, and the weighted term
   * already makes an intra-day redistribution visible. */
  digests: Record<string, string>;
  /** Per-app raw-window start (epoch seconds) of the last reconcile - the
   * previous precision mode of every bucket, in one small map. */
  rawFrom: Record<string, number>;
  /** Cached bindings; re-established by OBSERVE, never trusted. */
  identity: Array<{ key: string; native: Record<string, string | number> }>;
  /** Asserted-surface projections the seeded e2e checks. */
  surface: {
    apps: number;
    totalRequests: number;
    daily: Array<{ date: string; requests: number; http5xx: number }>;
  };
  /** Always empty: teardown reconciles to the empty set instead of
   * replaying recorded entries. Kept for on-disk shape stability. */
  teardown: Array<{ kind: string; done?: boolean }>;
}

export function digestDeclaration(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function heldStateDir(repoDir: string): string {
  return path.join(repoDir, ".ass", "state");
}

export function ledgerPath(repoDir: string, slug: string): string {
  return path.join(heldStateDir(repoDir), `${slug.toLowerCase()}.held.json`);
}

export function writeLedger(repoDir: string, ledger: LedgerFile): string {
  const file = ledgerPath(repoDir, ledger.slug);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n");
  renameSync(tmp, file);
  return file;
}

function parseLedger(filePath: string, raw: string): LedgerFile {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new CorruptStateError(
      filePath,
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const record = data as Partial<LedgerFile> | null;
  if (
    record === null ||
    typeof record !== "object" ||
    typeof record.slug !== "string" ||
    record.mode !== "up" ||
    !Array.isArray(record.teardown)
  ) {
    throw new CorruptStateError(filePath, "not a held-state ledger shape");
  }
  if (record.stateVersion !== STATE_VERSION) {
    throw new CorruptStateError(
      filePath,
      `stateVersion ${JSON.stringify(record.stateVersion)} - this build ` +
        `holds only stateVersion ${STATE_VERSION} worlds`,
    );
  }
  return record as LedgerFile;
}

/** null when nothing is held for the slug; corrupt content throws - a
 * ledger is an orphan record, so it must never silently read as absent. */
export function readLedger(repoDir: string, slug: string): LedgerFile | null {
  const file = ledgerPath(repoDir, slug);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return parseLedger(file, raw);
}

export interface LedgerListing {
  ledgers: LedgerFile[];
  corrupt: Array<{ path: string; error: string }>;
}

export function listLedgers(repoDir: string): LedgerListing {
  const dir = heldStateDir(repoDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { ledgers: [], corrupt: [] };
  }
  const listing: LedgerListing = { ledgers: [], corrupt: [] };
  for (const name of names.sort()) {
    if (!name.endsWith(".held.json")) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      listing.ledgers.push(parseLedger(file, readFileSync(file, "utf8")));
    } catch (err) {
      listing.corrupt.push({
        path: file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return listing;
}

export function releaseLedger(repoDir: string, slug: string): void {
  rmSync(ledgerPath(repoDir, slug), { force: true });
}

export function identityFromLedger(ledger: LedgerFile | null): IdentityMap {
  return ledger === null
    ? new IdentityMap()
    : IdentityMap.fromJSON(ledger.identity);
}

export function digestsFromLedger(
  ledger: LedgerFile | null,
): Map<string, string> {
  return new Map(Object.entries(ledger?.digests ?? {}));
}

export function rawFromLedger(ledger: LedgerFile | null): Map<string, number> {
  return new Map(Object.entries(ledger?.rawFrom ?? {}));
}
