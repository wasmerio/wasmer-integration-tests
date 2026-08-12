// Production safeguards (Phase 5). A prod run must clear three independent
// gates before any request is made: the explicit acknowledgement flag, an
// interactive confirmation, and fixed executor caps that neither the CLI nor
// any scenario field can raise. Stress profiles are rejected outright — an
// approved stress environment is Bugtopia's job once QA-643 qualifies it
// (D5), not production's.

import process from "node:process";
import { createInterface } from "node:readline/promises";
import { PreflightError } from "../errors";
import type { Scenario } from "../scenario/schema";

/** Non-overridable production load caps. Constants on purpose: a cap that a
 * profile field or flag could raise is not a cap. */
export const PROD_CAPS = {
  /** Highest sustained or ramped arrival rate, requests per second. */
  arrivalRate: 2,
  /** Most requests a single phase may inject. */
  arrivalCount: 60,
  /** Longest single phase, seconds. */
  phaseDurationSeconds: 60,
  /** Longest total load duration, seconds. */
  totalDurationSeconds: 120,
  /** Most concurrent virtual users. */
  maxVusers: 5,
} as const;

/** Artillery duration values may be numbers or "90s"/"2m" strings. Anything
 * unparseable is rejected conservatively — an unreadable bound is no bound. */
function durationSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const match = /^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h)?$/.exec(value.trim());
    if (match !== null) {
      const n = Number(match[1]);
      const unit = match[2] ?? "s";
      return unit.startsWith("m")
        ? n * 60
        : unit.startsWith("h")
          ? n * 3600
          : n;
    }
  }
  return null;
}

function checkPhases(phases: unknown, problems: string[]): void {
  if (!Array.isArray(phases)) {
    return;
  }
  let total = 0;
  phases.forEach((raw, i) => {
    const phase = (raw ?? {}) as Record<string, unknown>;
    const where = `phases[${i}]`;
    const duration = durationSeconds(phase["duration"]);
    if (phase["duration"] !== undefined && duration === null) {
      problems.push(
        `${where}.duration is not a duration the cap check can read ` +
          `(${JSON.stringify(phase["duration"])}); an unreadable bound is ` +
          "no bound",
      );
    }
    if (duration !== null) {
      total += duration;
      if (duration > PROD_CAPS.phaseDurationSeconds) {
        problems.push(
          `${where}.duration ${duration}s exceeds the production cap of ` +
            `${PROD_CAPS.phaseDurationSeconds}s per phase`,
        );
      }
    }
    for (const key of ["arrivalRate", "rampTo"] as const) {
      const value = phase[key];
      if (typeof value === "number" && value > PROD_CAPS.arrivalRate) {
        problems.push(
          `${where}.${key} ${value}/s exceeds the production cap of ` +
            `${PROD_CAPS.arrivalRate}/s`,
        );
      }
    }
    const count = phase["arrivalCount"];
    if (typeof count === "number" && count > PROD_CAPS.arrivalCount) {
      problems.push(
        `${where}.arrivalCount ${count} exceeds the production cap of ` +
          `${PROD_CAPS.arrivalCount}`,
      );
    }
    const vusers = phase["maxVusers"];
    if (typeof vusers === "number" && vusers > PROD_CAPS.maxVusers) {
      problems.push(
        `${where}.maxVusers ${vusers} exceeds the production cap of ` +
          `${PROD_CAPS.maxVusers}`,
      );
    }
  });
  if (total > PROD_CAPS.totalDurationSeconds) {
    problems.push(
      `total load duration ${total}s exceeds the production cap of ` +
        `${PROD_CAPS.totalDurationSeconds}s`,
    );
  }
}

/** Enforce the fixed production caps on the active profile, before any
 * fixture work. Rejects rather than clamps: a run that silently does less
 * than its declaration says would report on a workload nobody declared. */
export function enforceProdWorkload(
  scenario: Scenario,
  profileName: string,
): void {
  const executorName = scenario.load.executors[profileName] ?? profileName;
  if (executorName === "jest") {
    throw new PreflightError(
      `load profile "${profileName}" runs arbitrary jest workloads, which ` +
        "are not qualified for production; use dev or Bugtopia, or declare " +
        "a capped artillery-http profile",
    );
  }
  if (executorName !== "artillery-http") {
    // raw-wasmer runs the guest locally; production is only its registry.
    return;
  }
  const profile = scenario.load.profiles[profileName] ?? {};
  const problems: string[] = [];
  checkPhases(profile["phases"], problems);
  const config = profile["config"];
  if (config !== null && typeof config === "object") {
    checkPhases((config as Record<string, unknown>)["phases"], problems);
  }
  if (problems.length > 0) {
    throw new PreflightError(
      `load profile "${profileName}" is a stress profile by production's ` +
        "fixed caps, and stress profiles reject production by default " +
        "(scheduled stress belongs on Bugtopia once QA-643 qualifies it, " +
        "D5):\n" +
        problems.map((problem) => `  ${problem}`).join("\n") +
        "\nThese caps are constants; no flag or scenario field raises them.",
    );
  }
}

export type ProdConfirm = (question: string) => Promise<boolean>;

/** Interactive confirmation. Non-interactive contexts refuse: a pipeline
 * cannot acknowledge a production run on a human's behalf. */
export const defaultProdConfirm: ProdConfirm = async (question) => {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return false;
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(`${question} [yes/NO] `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
};
