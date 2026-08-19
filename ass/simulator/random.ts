// One seeded PRNG stream for every random choice the simulator makes
// (business-simulator-v1 §4.1): identical seed ⇒ identical names, timings
// and samples, which is what makes a scenario shareable ("run this file and
// you will see what I see") and Phase 6's exact-value assertions possible.
// mulberry32: tiny, fast, good enough distribution for fabricated data —
// cryptographic quality is a non-goal.

import { randomInt } from "node:crypto";

export interface Random {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform pick. */
  pick<T>(items: readonly T[]): T;
  /** Normal via Box-Muller, clamped to min when given. */
  normal(mean: number, stddev: number, min?: number): number;
  /** Derive an independent stream; use per app/day so consumption in one
   * generator cannot shift every later sample. */
  fork(label: string): Random;
}

function hashLabel(seed: number, label: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 2654435761);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

class Mulberry32 implements Random {
  private state: number;
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  normal(mean: number, stddev: number, min?: number): number {
    // Box-Muller; consume exactly two draws so the stream stays predictable.
    const u1 = Math.max(this.next(), Number.EPSILON);
    const u2 = this.next();
    const sample =
      mean + stddev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return min === undefined ? sample : Math.max(min, sample);
  }

  fork(label: string): Random {
    return new Mulberry32(hashLabel(this.seed, label));
  }
}

export function seededRandom(seed: number): Random {
  return new Mulberry32(seed);
}

/** Effective seed: the declared one, else a random 32-bit value the caller
 * must print in the §4.1 verbatim format. */
export function resolveSeed(declared: number | undefined): {
  seed: number;
  generated: boolean;
} {
  if (declared !== undefined) {
    return { seed: declared >>> 0, generated: false };
  }
  // node:crypto — `ass/simulator/` bans the global unseeded RNG outright
  // so no fabricated value can bypass the seeded stream unnoticed.
  return { seed: randomInt(0, 0x100000000) >>> 0, generated: true };
}

export function seedLine(seed: number): string {
  return `simulator: seed ${seed} (pass seed: ${seed} to reproduce)`;
}
