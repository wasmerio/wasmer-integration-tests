// D1 (section 9.2, normative): a digest is computable by BOTH halves. It is
// built from order-independent sums plus one position-weighted sum, so
// EXPAND reproduces it with no store access and a difference is always a
// real difference. No server-side hash function may appear in it - that is
// exactly the unreproducible shortcut that would restore the
// trust-the-ledger failure mode the reconciler exists to kill.

import { fingerprint } from "./model";

export interface DigestTerms {
  /** Number of members (hours in a day, lines in a group). */
  members: number;
  /** Order-independent sums, keyed by term name. */
  sums: Record<string, number>;
  /** Sum of value * (position + 1), UInt64 wraparound - makes a
   * redistribution of the same total across positions visible. */
  weighted: number;
}

export const UINT64 = 18446744073709551616n;

export function wrapU64(value: bigint): bigint {
  const wrapped = value % UINT64;
  return wrapped < 0n ? wrapped + UINT64 : wrapped;
}

export function digestFingerprint(terms: DigestTerms): string {
  const sums = Object.fromEntries(
    Object.entries(terms.sums)
      .map(([name, value]) => [name, Math.round(value)])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return fingerprint({
    m: terms.members,
    s: sums,
    w: Number(wrapU64(BigInt(Math.round(terms.weighted)))),
  });
}
