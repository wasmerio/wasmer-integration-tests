// The last completed `ass try` run, recorded so `ass promote` is deterministic
// from it rather than from transcription (§3, §8 of the design doc). The record
// is local scratch, not a committed artifact: it lives under `.ass/state/` and
// is gitignored, because it describes what one machine observed.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ScenarioOutcome, TargetEnv } from "../executors/contract";
import type { AssessmentKind, RunMode } from "./assessment";

export interface TryState {
  slug: string;
  recordedAt: string;
  /** Digest of the scenario.yaml that produced this run. Promotion refuses a
   * record whose declaration has since been edited — the pins below would
   * then describe a different experiment. */
  declarationDigest: string;
  env: TargetEnv;
  mode: RunMode;
  outcome: ScenarioOutcome;
  assessment: AssessmentKind;
  executor: string;
  /** Effective selectors (declaration + overrides). */
  selectors: Record<string, string>;
  /** Concrete selectors the target resolved those to. */
  pins: Record<string, string>;
  /** Disposition of the native baseline on that run (D10). Absent on records
   * written before baseline execution existed. */
  baseline?: string;
  reportPath: string;
}

export function digestDeclaration(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function stateDir(repoDir: string): string {
  return path.join(repoDir, ".ass", "state");
}

function stateFile(repoDir: string, slug: string): string {
  return path.join(stateDir(repoDir), `${slug.toLowerCase()}.json`);
}

export function recordTryState(repoDir: string, state: TryState): string {
  const file = stateFile(repoDir, state.slug);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
  return file;
}

/** null when no run has been recorded; a corrupt record reads as absent, so a
 * half-written file explains itself through the same prerequisite message. */
export function readTryState(repoDir: string, slug: string): TryState | null {
  try {
    return JSON.parse(
      readFileSync(stateFile(repoDir, slug), "utf8"),
    ) as TryState | null;
  } catch {
    return null;
  }
}

export function forgetTryState(repoDir: string, slug: string): void {
  rmSync(stateFile(repoDir, slug), { force: true });
}
