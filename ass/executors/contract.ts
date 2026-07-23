// Stable interfaces (QA-634, docs/anti-slop-shield-v1.md §5):
//   resolve(fixtures, targetEnv) -> ResolvedState
//   execute(load, ResolvedState) -> RunOutcome
//   report(scenario, ResolvedState, RunOutcome, verdict) -> JSON + summary
// Every executor — jest, artillery-http, raw-wasmer and the host-process
// micro-executor baselines and controls run on — implements the same
// `Executor` shape and returns the same `RunOutcome` (QA-637).

import { z } from "zod";

export const TARGET_ENVS = ["local", "dev", "bugtopia", "prod"] as const;
export type TargetEnv = (typeof TARGET_ENVS)[number];

/** Executors a `load:` profile may run on. Declared here rather than in the
 * registry so the schema can validate a declaration without importing the
 * implementations it would then have to load. `host-process` is absent on
 * purpose: baselines and controls reach it, a measured workload may not. */
export const LOAD_EXECUTOR_NAMES = [
  "jest",
  "artillery-http",
  "raw-wasmer",
] as const;
export type LoadExecutorName = (typeof LOAD_EXECUTOR_NAMES)[number];

export const SCENARIO_OUTCOMES = [
  "reproduced",
  "not-reproduced",
  "inconclusive",
  "setup-failed",
] as const;
export type ScenarioOutcome = (typeof SCENARIO_OUTCOMES)[number];

export interface ResolvedState {
  env: TargetEnv;
  /** Resolved template variables, e.g. `{ "victim.url": "https://…" }`. */
  variables: Record<string, string>;
  /** Concrete component versions after selector resolution. */
  components: Record<string, string>;
  /** What the target says each component *is*, expressed as a selector that
   * can be declared again. `components` describes a version for humans;
   * these are what `ass promote` writes back into a scenario (Phase 3). */
  pins: Record<string, string>;
  /** Environment the executor must inject (local: generated test-env.sh). */
  execEnv: Record<string, string>;
  /** Directory for this run's captured logs, evidence, and report. */
  artifactsDir: string;
  /** Combined platform-process log (`stream: edge|backend`), when captured. */
  composeLogPath: string | null;
  /** Never throws; returns cleanup errors so the original outcome survives. */
  cleanup: () => Promise<string[]>;
  /** Remote-target handle (Phase 5): the platform adapter and the apps this
   * run deployed, keyed by fixture name. Absent on local runs. Deliberately
   * untyped here so the executor contract never depends on the remote
   * module; the engine's remote capture path narrows it. */
  remote?: unknown;
}

/** Common executor result shape regardless of executor (QA-637). */
export interface RunOutcome {
  startedAt: string;
  finishedAt: string;
  counters: Record<string, number>;
  /** Stream name -> location of the captured raw log. */
  logs: Record<string, string>;
  /** Consistency cross-check for probe verdicts (D11), never a verdict source. */
  exitCode?: number;
  /** Signal that killed the process, when one did. Same cross-check role. */
  signal?: string | null;
  /** True when the executor killed the workload at its timeout: a hang must
   * stay distinguishable from a fast healthy run in the report. */
  timedOut?: boolean;
  /** Argv the executor actually ran, for the report. */
  command?: string[];
}

/** The compile-time half of the common-outcome contract is this interface;
 * the runtime half is `assertRunOutcome`, which every dispatch runs so a
 * hand-built or third-party executor cannot quietly return a different
 * shape. */
export interface ExecuteContext {
  /** Repository root: the cwd chained tools are spawned in. */
  repoDir: string;
  /** Directory the scenario was loaded from; relative entries resolve here. */
  scenarioDir: string;
  /** Log-file prefix under `artifactsDir`. A run captures several processes
   * (the workload, its baseline, each control), so they cannot share one. */
  label?: string;
  /** Test seam replacing the real spawn-and-capture. */
  exec?: WorkloadExec;
  /** Every captured line, for the presenter. */
  onLine?: (line: string) => void;
}

export interface Executor {
  readonly name: string;
  /** Probe channel types (D11) this executor can deliver a verdict on: a
   * process executor carries `log`, an HTTP one carries `http`. Verdict
   * blocks declare every channel their probe emits on, so switching the
   * active profile must not require rewriting the verdict. */
  readonly probeChannels: ReadonlyArray<"log" | "http">;
  /** Validate the declared profile without running anything. */
  parseProfile(raw: Record<string, unknown>): void;
  execute(
    raw: Record<string, unknown>,
    state: ResolvedState,
    ctx: ExecuteContext,
  ): Promise<RunOutcome>;
}

export interface WorkloadResult {
  exitCode: number;
  /** True when the exec killed the workload at its timeout. */
  timedOut: boolean;
  signal?: string | null;
}

export type WorkloadExec = (
  argv: string[],
  opts: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    stdoutFile: string;
    stderrFile: string;
    timeoutSeconds: number;
    onLine?: (line: string) => void;
  },
) => Promise<WorkloadResult>;

/** A declared profile the executor cannot run. Reported as a usage error
 * (D15 exit 1), never as a setup failure. */
export class ExecutorProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorProfileError";
  }
}

/** Uniform profile-rejection message, so every executor's schema errors read
 * the same way regardless of who wrote the executor. */
export function profileError(
  executor: string,
  error: z.ZodError,
): ExecutorProfileError {
  return new ExecutorProfileError(
    `invalid ${executor} executor profile:\n` +
      error.issues
        .map(
          (issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`,
        )
        .join("\n"),
  );
}

const runOutcomeSchema = z.object({
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  counters: z.record(z.number()),
  logs: z.record(z.string().min(1)),
  exitCode: z.number().optional(),
  signal: z.string().nullable().optional(),
  timedOut: z.boolean().optional(),
  command: z.array(z.string()).optional(),
});

/** Runtime half of the common-outcome contract: an executor that returns
 * something else is an internal fault, not a scenario problem, so this
 * throws a plain Error and propagates with its stack. */
export function assertRunOutcome(
  outcome: unknown,
  executorName: string,
): RunOutcome {
  const parsed = runOutcomeSchema.safeParse(outcome);
  if (!parsed.success) {
    throw new Error(
      `executor "${executorName}" returned a value that is not a RunOutcome:\n` +
        parsed.error.issues
          .map(
            (issue) =>
              `  ${issue.path.join(".") || "(root)"}: ${issue.message}`,
          )
          .join("\n"),
    );
  }
  return outcome as RunOutcome;
}
