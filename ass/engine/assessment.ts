// Assessment derivation (D6) and exit-code enumeration (D15): exit codes and
// alerting follow lifecycle × pinned/floating mode, never the raw verdict.
// Table in docs/anti-slop-shield-v1.md §4 "Lifecycle and assessment".

import type { ScenarioOutcome } from "../executors/contract";
import type { Lifecycle } from "../scenario/schema";

export type RunMode = "pinned" | "floating";

export type AssessmentKind =
  | "expected"
  | "informational"
  | "candidate-fix"
  | "alert"
  | "inconclusive"
  | "setup-failed";

export interface Assessment {
  kind: AssessmentKind;
  exitCode: number;
  alerting: boolean;
  reason: string;
}

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_ALERT = 2;
export const EXIT_INCONCLUSIVE = 3;
export const EXIT_SETUP_FAILED = 4;

function make(kind: AssessmentKind, reason: string): Assessment {
  const exitCode =
    kind === "alert"
      ? EXIT_ALERT
      : kind === "inconclusive"
        ? EXIT_INCONCLUSIVE
        : kind === "setup-failed"
          ? EXIT_SETUP_FAILED
          : EXIT_OK;
  return { kind, exitCode, alerting: kind === "alert", reason };
}

export interface AssessOptions {
  /** The scenario is a draft under experiments/. Drafts are never scheduled
   * and carry no regression contract, so they never alert: an experiment
   * that stopped triggering is a fact about the experiment, not repro rot. */
  draft?: boolean;
  /** The draft declares no verdict, so the run only surfaced logs. */
  verdictless?: boolean;
}

function assessDraft(
  outcome: ScenarioOutcome,
  options: AssessOptions,
): Assessment {
  if (options.verdictless === true) {
    return make(
      "informational",
      "the draft declares no verdict — the run surfaced logs and metrics only",
    );
  }
  if (outcome === "inconclusive") {
    return make(
      "inconclusive",
      "the workload ran but matched no expectation; never folded into not-reproduced",
    );
  }
  return outcome === "reproduced"
    ? make(
        "informational",
        "the draft reproduces — `ass promote` turns it into a pinned repro",
      )
    : make(
        "informational",
        "the draft did not reproduce; keep iterating with `ass try`",
      );
}

export function assess(
  lifecycle: Lifecycle,
  mode: RunMode,
  outcome: ScenarioOutcome,
  options: AssessOptions = {},
): Assessment {
  if (outcome === "setup-failed") {
    return make("setup-failed", "fixture resolution or setup failed");
  }
  if (options.draft === true) {
    return assessDraft(outcome, options);
  }
  if (outcome === "inconclusive") {
    return make(
      "inconclusive",
      "the workload ran but matched no expectation; never folded into not-reproduced",
    );
  }

  if (lifecycle.state === "retired") {
    return make(
      "informational",
      `scenario is retired (superseded by ${lifecycle.superseded_by}); ` +
        "runs carry no alerting semantics",
    );
  }

  const reproduced = outcome === "reproduced";
  if (lifecycle.state === "open") {
    if (mode === "pinned") {
      return reproduced
        ? make("expected", "repro intact on the pinned versions")
        : make("alert", "repro rot: pinned versions no longer reproduce");
    }
    return reproduced
      ? make("informational", "bug still present upstream")
      : make(
          "candidate-fix",
          "floating run no longer reproduces — consider flipping lifecycle to fixed",
        );
  }

  // lifecycle.state === "fixed"
  if (mode === "pinned") {
    return reproduced
      ? make("expected", "old pinned versions still fail, as documented")
      : make("alert", "repro/pin rot: the pinned reproduction is broken");
  }
  return reproduced
    ? make("alert", "regression: a fixed bug reproduces on floating versions")
    : make("expected", "fix holds on floating versions");
}
