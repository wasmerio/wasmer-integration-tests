// The ledger (`.ass/state/<slug>.held.json`, `stateVersion: 2`). It has
// exactly three roles and they must not be confused: an inspection surface,
// a fast path, and a record of the **last declared intent**. It is never a
// record of state - losing it degrades the engine to additive-only plus one
// full OBSERVE, never to a wrong write, and that asymmetry is the rule for
// anything later added to it.
//
// The file is a superset of the v1 descriptor shape (same `slug`, `mode`
// and `teardown` keys), so v1's `status` still reads a v2 world instead of
// calling it corrupt.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Declaration } from "./scenario";
import { IdentityMap } from "./identity";

export const STATE_VERSION = 2;

export interface LedgerFile {
  stateVersion: 2;
  engine: "v2";
  slug: string;
  mode: "up";
  assSchema: number;
  scenarioPath: string;
  seed: number;
  declarationDigest: string;
  heldAt: string;
  completedAt: string | null;
  ownsPlatform: boolean;
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
  /** Always empty: v2 tears down by reconciling to the empty set, not by
   * replaying recorded entries. Present so v1 tooling can still parse. */
  teardown: [];
}

export function digestDeclaration(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function ledgerPath(repoDir: string, slug: string): string {
  return path.join(repoDir, ".ass", "state", `${slug.toLowerCase()}.held.json`);
}

export function writeLedger(repoDir: string, ledger: LedgerFile): string {
  const file = ledgerPath(repoDir, ledger.slug);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n");
  renameSync(tmp, file);
  return file;
}

export function readLedger(repoDir: string, slug: string): LedgerFile | null {
  let raw: string;
  try {
    raw = readFileSync(ledgerPath(repoDir, slug), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = parsed as Partial<LedgerFile>;
  return record.stateVersion === STATE_VERSION ? (record as LedgerFile) : null;
}

/** A v1 hold for the same slug: `up` rebuilds it once (Q-B) rather than
 * backfilling markers into a world that is local and disposable. */
export function isV1Hold(repoDir: string, slug: string): boolean {
  try {
    const parsed = JSON.parse(
      readFileSync(ledgerPath(repoDir, slug), "utf8"),
    ) as {
      stateVersion?: number;
      teardown?: unknown[];
    };
    return (
      parsed.stateVersion !== STATE_VERSION && Array.isArray(parsed.teardown)
    );
  } catch {
    return false;
  }
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
