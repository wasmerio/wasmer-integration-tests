// Unit tests for the D6 assessment derivation and D15 exit-code enumeration:
// every lifecycle × mode × outcome combination, exit codes following the
// assessment and never the raw verdict fact.

import {
  assess,
  EXIT_ALERT,
  EXIT_INCONCLUSIVE,
  EXIT_OK,
  EXIT_SETUP_FAILED,
  type RunMode,
} from "../../ass/engine/assessment";
import type { Lifecycle } from "../../ass/scenario/schema";
import type { ScenarioOutcome } from "../../ass/executors/contract";

const OPEN: Lifecycle = { state: "open" };
const FIXED: Lifecycle = {
  state: "fixed",
  fixed_in: { edge: "v2026-08-01_1" },
  fixed_at: "2026-08-01",
  evidence: "https://linear.app/wasmer/issue/WAX-600",
};
const RETIRED: Lifecycle = {
  state: "retired",
  superseded_by: "tests/superpanics/wax-600.test.ts",
};

describe("assessment matrix (lifecycle × mode × definite outcome)", () => {
  test.each<[Lifecycle, RunMode, ScenarioOutcome, string, number]>([
    [OPEN, "pinned", "reproduced", "expected", EXIT_OK],
    [OPEN, "pinned", "not-reproduced", "alert", EXIT_ALERT],
    [OPEN, "floating", "reproduced", "informational", EXIT_OK],
    [OPEN, "floating", "not-reproduced", "candidate-fix", EXIT_OK],
    [FIXED, "pinned", "reproduced", "expected", EXIT_OK],
    [FIXED, "pinned", "not-reproduced", "alert", EXIT_ALERT],
    [FIXED, "floating", "reproduced", "alert", EXIT_ALERT],
    [FIXED, "floating", "not-reproduced", "expected", EXIT_OK],
    [RETIRED, "pinned", "reproduced", "informational", EXIT_OK],
    [RETIRED, "pinned", "not-reproduced", "informational", EXIT_OK],
    [RETIRED, "floating", "reproduced", "informational", EXIT_OK],
    [RETIRED, "floating", "not-reproduced", "informational", EXIT_OK],
  ])(
    "%o × %s × %s -> %s (exit %i)",
    (lifecycle, mode, outcome, kind, exitCode) => {
      const assessment = assess(lifecycle, mode, outcome);
      expect(assessment.kind).toBe(kind);
      expect(assessment.exitCode).toBe(exitCode);
      expect(assessment.alerting).toBe(kind === "alert");
      expect(assessment.reason).not.toBe("");
    },
  );
});

describe("inconclusive and setup-failed dominate lifecycle and mode", () => {
  const lifecycles: Lifecycle[] = [OPEN, FIXED, RETIRED];
  const modes: RunMode[] = ["pinned", "floating"];

  test("inconclusive always exits 3 and never alerts", () => {
    for (const lifecycle of lifecycles) {
      for (const mode of modes) {
        const assessment = assess(lifecycle, mode, "inconclusive");
        expect(assessment.kind).toBe("inconclusive");
        expect(assessment.exitCode).toBe(EXIT_INCONCLUSIVE);
        expect(assessment.alerting).toBe(false);
      }
    }
  });

  test("setup-failed always exits 4 and never alerts", () => {
    for (const lifecycle of lifecycles) {
      for (const mode of modes) {
        const assessment = assess(lifecycle, mode, "setup-failed");
        expect(assessment.kind).toBe("setup-failed");
        expect(assessment.exitCode).toBe(EXIT_SETUP_FAILED);
        expect(assessment.alerting).toBe(false);
      }
    }
  });
});
