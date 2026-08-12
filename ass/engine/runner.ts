// Run orchestration: preflight → resolve fixtures (local stack or remote
// TestEnv target) → execute the active load profile → capture remote
// evidence in the D14 window → evaluate the verdict → derive the assessment
// (D6/D15) → report. Production adds three independent gates (Phase 5).
// Engine capabilities not yet implemented fail preflight rather than
// degrade (D7).

import { readFileSync } from "node:fs";
import path from "node:path";
import { interpolate } from "../executors/template";
import type {
  RunOutcome,
  ResolvedState,
  ScenarioOutcome,
  TargetEnv,
} from "../executors/contract";
import type { LoadedScenario } from "../scenario/loader";
import { baselineSpecOf } from "../scenario/schema";
import type { Scenario, Verdict } from "../scenario/schema";
import {
  requiresPlatform,
  resolveLocal,
  SetupFailedError,
  type EffectiveFixtures,
  type LocalResolveDeps,
  type Perturbation,
} from "../fixtures/local";
import type { WorkloadExec } from "../executors/contract";
import { assertRunOutcome, resolveExecutor } from "../executors/registry";
import { LocalPlatformDriver } from "../fixtures/localPlatform";
import { assess, type RunMode } from "./assessment";
import { digestDeclaration, recordTryState } from "./state";
import {
  preflightRemoteConfig,
  resolveRemote,
  type RemoteEnv,
  type RemoteResolveDeps,
} from "../fixtures/remote";
import {
  classifyLogStream,
  collectPredicates,
  planChannels,
  preflightLoad,
  preflightVerdict,
  PreflightError,
} from "./capabilities";
import {
  captureRemote,
  remoteStreamSources,
  type CaptureOptions,
} from "./remoteCapture";
import {
  defaultProdConfirm,
  enforceProdWorkload,
  type ProdConfirm,
} from "./prod";
import {
  runComparisons,
  summarizeComparisons,
  type ComparisonResult,
  type EnginePresence,
} from "./comparison";
import {
  evaluateVerdict,
  localStreamSources,
  type VerdictEvaluation,
} from "./verdict";
import type { Presenter } from "../report/presenter";
import {
  formatSummary,
  redactReport,
  secretsOf,
  writeReport,
  type PhaseTiming,
  type RunReport,
  type RunTiming,
} from "../report/report";

export interface RunOverrides {
  env: TargetEnv;
  cpus?: number;
  executor?: string;
  components: Record<string, string>;
  /** `--i-know-this-is-prod` (Phase 5): the first of production's three
   * gates. Ignored on every other target. */
  prodAcknowledged?: boolean;
}

export interface RunnerIo {
  out(line: string): void;
  err(line: string): void;
}

export interface RunnerDeps extends LocalResolveDeps {
  workloadExec?: WorkloadExec;
  /** Test seam for "is this native engine installed on the host". */
  enginePresence?: EnginePresence;
  /** Remote-target seams (Phase 5): the TestEnv-backed platform adapter. */
  remote?: RemoteResolveDeps;
  /** D14 capture knobs (quiescence/poll/max wait) and their test seams. */
  capture?: Partial<CaptureOptions>;
  /** Production's second gate; injectable so tests never open a prompt. */
  confirmProd?: ProdConfirm;
  /** Test seam for the run clock. */
  now?: () => number;
  /** Test seam for interrupt delivery and process exit. */
  signals?: SignalTrap;
  exit?: (code: number) => void;
}

/** Interrupt plumbing, injectable so the restore-on-interrupt path is
 * testable without signalling the jest worker. */
export interface SignalTrap {
  arm(handler: (signal: NodeJS.Signals) => void): void;
  disarm(): void;
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGINT: 2, SIGTERM: 15 };

function processSignalTrap(): SignalTrap {
  let armed: Array<[NodeJS.Signals, () => void]> = [];
  return {
    arm(handler) {
      for (const signal of Object.keys(SIGNAL_NUMBERS) as NodeJS.Signals[]) {
        const listener = (): void => handler(signal);
        process.on(signal, listener);
        armed.push([signal, listener]);
      }
    },
    disarm() {
      for (const [signal, listener] of armed) {
        process.off(signal, listener);
      }
      armed = [];
    },
  };
}

export interface RunnerPresentation {
  presenter?: Presenter;
  verbose?: boolean;
}

/** Engine capabilities that exist in the schema but not yet in the engine.
 * Running them silently would fake outcomes, so they fail preflight (D7).
 * App-instance streams read the deployed app's logs over Vector→Loki, which
 * exists on remote targets (Phase 5); the local adapter is still a QA-640
 * follow-up. */
function gateUnimplemented(verdict: Verdict | undefined, env: TargetEnv): void {
  const gaps: string[] = [];
  if (verdict === undefined || env !== "local") {
    return;
  }
  const appStreams = new Set<string>();
  for (const p of collectPredicates(verdict)) {
    if (
      p.stream !== undefined &&
      classifyLogStream(p.stream) === "app-instance"
    ) {
      appStreams.add(p.stream);
    }
  }
  for (const entry of verdict.collect ?? []) {
    for (const spec of Object.values(entry)) {
      if (classifyLogStream(spec.stream) === "app-instance") {
        appStreams.add(spec.stream);
      }
    }
  }
  if (appStreams.size > 0) {
    gaps.push(
      `log_matches on app-instance stream(s) ` +
        `(${Array.from(appStreams).sort().join(", ")}) reads deployed-app ` +
        "logs through Vector→Loki, which the local target cannot yet " +
        "(QA-640 follow-up); remote targets (--env dev|bugtopia|prod) can. " +
        "A probe's own process output is verdict.probe with {type: log}",
    );
  }
  if (gaps.length > 0) {
    throw new PreflightError(
      "the engine cannot run this scenario yet; no fixtures were resolved:\n" +
        gaps.map((gap) => `  ${gap}`).join("\n"),
    );
  }
}

/** One line naming what the active profile is about to do. Each executor's
 * most identifying field differs, so a generic dump would bury it — and it
 * is stated post-interpolation, because `{{ component.python }}` tells the
 * reader nothing about which interpreter is actually being run. */
function describeProfile(
  executorName: string,
  scenario: Scenario,
  state: ResolvedState,
): string {
  const profile = scenario.load.profiles[executorName] ?? {};
  const raw = profile["spec"] ?? profile["package"] ?? profile["target"] ?? "";
  if (typeof raw !== "string" || raw === "") {
    return executorName;
  }
  let headline = raw;
  try {
    headline = interpolate(raw, state.variables, "load");
  } catch {
    headline = raw; // a bad reference is the executor's error to report
  }
  return `${executorName}: ${headline}`;
}

export function mergeEffectiveFixtures(
  loaded: LoadedScenario,
  overrides: RunOverrides,
  activeExecutor: string = overrides.executor ??
    loaded.scenario.load.activeExecutor,
): EffectiveFixtures {
  const components = {
    ...(loaded.scenario.fixtures.components ?? {}),
    ...overrides.components,
  };
  const perturbations: Record<string, Perturbation> = {};
  for (const [service, perturbation] of Object.entries(
    loaded.scenario.fixtures.perturbations ?? {},
  )) {
    perturbations[service] = { ...perturbation };
  }
  if (overrides.cpus !== undefined) {
    const capped = Object.values(perturbations).filter(
      (perturbation) => perturbation.cpus !== undefined,
    );
    if (capped.length === 0) {
      throw new PreflightError(
        "--cpus overrides a declared cpus perturbation, but the scenario " +
          "declares none under fixtures.perturbations",
      );
    }
    for (const perturbation of capped) {
      perturbation.cpus = overrides.cpus;
    }
  }
  return { components, perturbations, executor: activeExecutor };
}

export async function runScenario(
  loaded: LoadedScenario,
  overrides: RunOverrides,
  mode: RunMode,
  options: {
    cwd: string;
    io: RunnerIo;
    deps?: RunnerDeps;
    presenter?: Presenter;
  },
): Promise<number> {
  const { cwd, io } = options;
  // Without a presenter (tests, embedding) everything still goes through the
  // plain io, so the run stays scriptable.
  const view = options.presenter;
  const deps = options.deps ?? {};
  const scenario = loaded.scenario;
  const verdict = scenario.verdict;
  // A draft may omit the verdict: the run then just surfaces logs and metrics
  // (§3). A persisted scenario without one cannot pass its own schema, so
  // this stays a guard against an internally constructed scenario.
  const isDraft = loaded.kind === "experiment";
  if (verdict === undefined && !isDraft) {
    throw new PreflightError(
      "the scenario declares no verdict; only drafts under experiments/ " +
        "may omit it",
    );
  }
  const assessOptions = {
    draft: isDraft,
    verdictless: verdict === undefined,
  };

  // `executorName` is the *profile* the run selected; the executor that runs
  // it may be named separately (two raw-wasmer profiles is a legal shape).
  const executorName = overrides.executor ?? scenario.load.activeExecutor;
  const actualExecutorName =
    scenario.load.executors[executorName] ?? executorName;
  const executor = resolveExecutor(actualExecutorName);

  // Production's three gates (Phase 5), cheapest first: the flag and the
  // fixed caps refuse before anything else runs, the interactive
  // confirmation is last so nobody is prompted for a run that would refuse
  // anyway. All of it precedes any request or fixture work.
  if (overrides.env === "prod") {
    if (overrides.prodAcknowledged !== true) {
      throw new PreflightError(
        'target "prod" requires --i-know-this-is-prod, interactive ' +
          "confirmation, and runs under fixed non-overridable caps; " +
          "nothing has been run",
      );
    }
    enforceProdWorkload(scenario, executorName);
  }

  gateUnimplemented(verdict, overrides.env);
  preflightLoad(scenario, executorName, overrides.env);
  preflightVerdict(scenario, overrides.env, executorName);
  if (overrides.env !== "local") {
    // D13 on remote targets is decidable from the declaration alone, so an
    // unhonorable config refuses before any fixture work.
    preflightRemoteConfig(scenario, overrides.env);
  }

  const hasPerturbations =
    Object.keys(scenario.fixtures.perturbations ?? {}).length > 0 ||
    overrides.cpus !== undefined;
  if (overrides.env !== "local" && hasPerturbations) {
    const warning =
      `perturbations are ignored on remote targets — you don't ` +
      `get to CPU-starve or cache-wipe "${overrides.env}"`;
    if (view) {
      view.warn(warning);
    } else {
      io.err(`warning: ${warning}`);
    }
  }

  if (overrides.env === "prod") {
    const confirm = deps.confirmProd ?? defaultProdConfirm;
    const confirmed = await confirm(
      `Run scenario ${scenario.meta.id} against PRODUCTION ` +
        `(registry.wasmer.io) under the fixed caps?`,
    );
    if (!confirmed) {
      throw new PreflightError(
        "production run not confirmed (interactive confirmation is " +
          "required; non-interactive contexts refuse); nothing has been run",
      );
    }
  }

  const effective = mergeEffectiveFixtures(loaded, overrides, executorName);

  const clock = deps.now ?? (() => Date.now());
  const runStarted = clock();
  const phases: PhaseTiming[] = [];
  const timePhase = async <T>(
    name: PhaseTiming["name"],
    body: () => Promise<T>,
  ): Promise<T> => {
    const started = clock();
    try {
      return await body();
    } finally {
      const finished = clock();
      phases.push({
        name,
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date(finished).toISOString(),
        seconds: (finished - started) / 1000,
      });
    }
  };
  const timingNow = (): RunTiming => ({
    startedAt: new Date(runStarted).toISOString(),
    finishedAt: new Date(clock()).toISOString(),
    seconds: (clock() - runStarted) / 1000,
    phases,
  });

  const emit = (report: RunReport, reportPath: string): void => {
    const lines = formatSummary(report, reportPath, {
      cwd,
      continued: view !== undefined,
      color: view?.color,
    });
    if (view) {
      view.summary(lines);
    } else {
      for (const line of lines) {
        io.out(line);
      }
    }
  };

  /** Redact, persist, and hand back the report the summary must render
   * from. An unwritable report directory costs the file, never the verdict
   * or evidence (QA-641); a schema violation is an internal fault and
   * propagates. */
  const deliver = (
    report: RunReport,
    reportPath: string,
    secrets: readonly string[],
  ): RunReport => {
    const redacted = redactReport(report, secrets);
    try {
      writeReport(reportPath, redacted);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("internal:")) {
        throw err;
      }
      const message =
        `could not write the run report to ${reportPath}: ` +
        `${err instanceof Error ? err.message : String(err)} — the verdict ` +
        "and evidence in the summary remain valid";
      if (view) {
        view.warn(message);
      } else {
        io.err(`warning: ${message}`);
      }
    }
    return redacted;
  };

  const baseReport: Omit<
    RunReport,
    | "outcome"
    | "assessment"
    | "verdict"
    | "evidence"
    | "workload"
    | "timing"
    | "comparisons"
    | "degraded"
  > = {
    scenario: {
      id: scenario.meta.id,
      title: scenario.meta.title,
      slug: loaded.slug,
      lifecycle: scenario.meta.lifecycle,
    },
    target: { env: overrides.env, mode },
    selectors: effective.components,
    components: effective.components,
    executor: {
      name: executorName,
      profile: scenario.load.profiles[executorName],
    },
    setupFailure: null,
    diagnosis: [],
    cleanupErrors: [],
  };

  const resolveIo = deps.io ?? {
    info: (line: string) => (view ? view.note(line) : io.err(line)),
  };
  const onLine = (line: string): void => {
    if (view) {
      view.child(line);
    } else if (line.trim().length > 0) {
      io.err(line);
    }
  };
  const driver =
    deps.driver ?? new LocalPlatformDriver(cwd, { io: resolveIo, onLine });

  // Ctrl-C during a boot that takes minutes must not leave the checkout
  // mutated (integration contract: never leave local.env or the compose file
  // changed). Restoration here is deliberately synchronous and file-only —
  // an interrupt does not get to wait out a ~45s container teardown, so the
  // stack is reported as still running instead.
  const trap = deps.signals ?? processSignalTrap();
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let interrupted = false;
  trap.arm((signal) => {
    if (interrupted) {
      return;
    }
    interrupted = true;
    const say = (line: string): void =>
      view ? view.warn(line) : io.err(`warning: ${line}`);
    say(`interrupted by ${signal} — restoring mutated files`);
    for (const error of driver.restoreFiles()) {
      say(`restore error: ${error}`);
    }
    if (driver.currentRunDir() !== null) {
      say(
        "the local platform is still up; tear it down with: make local-platform-down",
      );
    }
    view?.close();
    exit(128 + (SIGNAL_NUMBERS[signal] ?? 0));
  });

  let state;
  try {
    view?.step(
      "setup",
      overrides.env !== "local"
        ? `resolving fixtures against ${overrides.env}`
        : requiresPlatform(scenario, effective)
          ? "resolving fixtures · booting the local platform"
          : "resolving fixtures",
    );
    state = await timePhase("setup", () =>
      overrides.env === "local"
        ? resolveLocal(scenario, loaded.dir, effective, {
            driver,
            deployApp: deps.deployApp,
            io: resolveIo,
          })
        : resolveRemote(
            scenario,
            loaded.dir,
            effective,
            overrides.env as RemoteEnv,
            cwd,
            { ...(deps.remote ?? {}), io: resolveIo },
          ),
    );
  } catch (err) {
    trap.disarm();
    if (!(err instanceof SetupFailedError)) {
      throw err;
    }
    const assessment = assess(
      scenario.meta.lifecycle,
      mode,
      "setup-failed",
      assessOptions,
    );
    const report: RunReport = {
      ...baseReport,
      outcome: "setup-failed",
      assessment,
      verdict: null,
      comparisons: [],
      degraded: [],
      evidence: [],
      workload: null,
      timing: timingNow(),
      setupFailure: err.message,
      diagnosis: view?.diagnosis() ?? [],
      cleanupErrors: err.cleanupErrors,
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join(
      cwd,
      ".local-platform",
      "ass",
      `${loaded.slug}-${stamp}-setup-failed.json`,
    );
    emit(deliver(report, reportPath, []), reportPath);
    return assessment.exitCode;
  }

  baseReport.components = state.components;

  // A workload that fails to *execute* (spawn failure, not a failing test
  // run — those return an outcome) must still end as a reported D15 exit,
  // never an unhandled internal fault. A fault in evaluateVerdict itself
  // stays internal and propagates: with patterns compiled at preflight it
  // has no reachable external cause left.
  let outcome: RunOutcome | null = null;
  let evaluation: VerdictEvaluation | null = null;
  let comparisons: ComparisonResult[] = [];
  let workloadFailure: string | null = null;
  let cleanupErrors: string[] = [];
  const executeContext = {
    repoDir: cwd,
    scenarioDir: loaded.dir,
    exec: deps.workloadExec,
    onLine,
  };
  // R5-01: only the channels the active executor and target can deliver are
  // ever read — an HTTP run's own stderr never masquerades as the probe's.
  const probePlans =
    verdict?.probe === undefined
      ? []
      : planChannels(verdict.probe.channels, actualExecutorName, overrides.env);
  try {
    view?.step("workload", describeProfile(executorName, scenario, state));
    const workloadStartMs = clock();
    await timePhase("workload", async () => {
      try {
        outcome = assertRunOutcome(
          await executor.execute(
            scenario.load.profiles[executorName],
            state,
            executeContext,
          ),
          executorName,
        );
      } catch (err) {
        workloadFailure = err instanceof Error ? err.message : String(err);
      }
    });
    if (outcome !== null && verdict !== undefined) {
      let sources = localStreamSources(state);
      let captures = {};
      if (overrides.env !== "local") {
        // The D14 scan window: opened at workload start, closed after the
        // capture's bounded quiescence timeout. Everything the verdict reads
        // remotely comes from these captures and nothing else.
        view?.step("collect", "capturing remote evidence (D14 window)");
        const captured = await timePhase("collect", () =>
          captureRemote(scenario, state, probePlans, {
            workloadStartMs,
            ...(deps.capture ?? {}),
            io: resolveIo,
          }),
        );
        captures = captured.captures;
        sources = remoteStreamSources(captured.appStreamFiles);
      }
      evaluation = evaluateVerdict(
        verdict,
        outcome,
        sources,
        verdict.probe === undefined ? null : { plans: probePlans, captures },
      );
    }
    // Baseline and controls run against the same resolved state, after the
    // measured workload so they cannot perturb it. They are cheap local
    // processes, so they are not something a run opts into (D10).
    if (outcome !== null && verdict !== undefined) {
      const declared =
        (verdict.baseline !== undefined &&
          baselineSpecOf(verdict.baseline) !== null) ||
        Object.keys(verdict.controls ?? {}).length > 0;
      const run = (): Promise<ComparisonResult[]> =>
        runComparisons(scenario, state, {
          ...executeContext,
          enginePresence: deps.enginePresence,
        });
      // A waived baseline still gets recorded, but it spends no wall clock,
      // so it does not earn a phase in the timing breakdown.
      if (declared) {
        view?.step("baseline", "native differential and declared controls");
        comparisons = await timePhase("comparison", run);
      } else {
        comparisons = await run();
      }
      for (const result of comparisons) {
        if (result.status === "waived" || result.status === "ok") {
          continue;
        }
        const say = `${result.name}: ${result.detail}`;
        if (view) {
          view.warn(say);
        } else {
          io.err(`warning: ${say}`);
        }
      }
    }
  } finally {
    // The verdict is already known here; teardown takes ~45s on a real
    // stack, so say the answer before spending it rather than after.
    const teardown =
      overrides.env !== "local"
        ? "; cleaning up remote fixtures"
        : requiresPlatform(scenario, effective)
          ? "; tearing down"
          : "";
    if (view) {
      view.step(
        "cleanup",
        evaluation !== null
          ? `verdict ${evaluation.outcome}${teardown}`
          : "tearing down",
      );
    } else if (evaluation !== null) {
      io.err(`verdict: ${evaluation.outcome}${teardown}`);
    }
    cleanupErrors = await timePhase("cleanup", () => state.cleanup());
    for (const error of cleanupErrors) {
      if (view) {
        view.warn(`cleanup error: ${error}`);
      } else {
        io.err(`cleanup error: ${error}`);
      }
    }
    // Nothing is mutated past this point, so the interrupt handler has
    // nothing left to protect.
    trap.disarm();
  }

  if (outcome === null) {
    const assessment = assess(
      scenario.meta.lifecycle,
      mode,
      "setup-failed",
      assessOptions,
    );
    const report: RunReport = {
      ...baseReport,
      outcome: "setup-failed",
      assessment,
      verdict: null,
      comparisons: [],
      degraded: [],
      evidence: [],
      workload: null,
      timing: timingNow(),
      setupFailure: `the workload failed to execute: ${workloadFailure}`,
      diagnosis: view?.diagnosis() ?? [],
      cleanupErrors,
    };
    const reportPath = path.join(state.artifactsDir, "report.json");
    emit(deliver(report, reportPath, secretsOf(state.execEnv)), reportPath);
    return assessment.exitCode;
  }

  // A verdict-less draft ran but proved nothing: `inconclusive` is the honest
  // outcome, and the draft assessment keeps it out of alerting (D6).
  let scenarioOutcome: ScenarioOutcome = evaluation?.outcome ?? "inconclusive";
  let verdictReason = evaluation?.reason ?? null;
  // A baseline or control that ran and disagreed with its own declaration
  // invalidates the run: either the probe is broken or the bug is not the one
  // claimed, and no reproduction or fix claim survives either way (D10).
  const { violations, degraded } = summarizeComparisons(comparisons);
  if (violations.length > 0 && scenarioOutcome !== "setup-failed") {
    scenarioOutcome = "inconclusive";
    verdictReason =
      violations
        .map(
          (violation) =>
            `${violation.kind} "${violation.name}" expected ` +
            `${violation.expected} but observed ${violation.observed} ` +
            `(${violation.detail})`,
        )
        .join("; ") +
      (verdictReason === null ? "" : `; workload: ${verdictReason}`);
  }
  const assessment = assess(
    scenario.meta.lifecycle,
    mode,
    scenarioOutcome,
    assessOptions,
  );
  const report: RunReport = {
    ...baseReport,
    outcome: scenarioOutcome,
    assessment,
    verdict:
      evaluation === null
        ? null
        : {
            reproducedMatched: evaluation.reproducedMatched,
            notReproducedMatched: evaluation.notReproducedMatched,
            probe: evaluation.probe,
            matchedPredicates: evaluation.matchedPredicates,
            unavailableStreams: evaluation.unavailableStreams,
            reason: verdictReason ?? evaluation.reason,
          },
    comparisons,
    degraded: degraded.map((result) => `${result.name}: ${result.detail}`),
    evidence: evaluation?.evidence ?? [],
    workload: {
      startedAt: outcome.startedAt,
      finishedAt: outcome.finishedAt,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      command: outcome.command,
      counters: outcome.counters,
      logs: outcome.logs,
    },
    timing: timingNow(),
    cleanupErrors,
  };
  const reportPath = path.join(state.artifactsDir, "report.json");
  const delivered = deliver(report, reportPath, secretsOf(state.execEnv));
  // Promotion has to be deterministic from a run that happened, not from a
  // human retyping what it resolved to (§8), so a completed draft run leaves
  // its resolved pins behind. Failing to write scratch state must never cost
  // the run its summary (the R3-02 class): warn and carry on.
  if (isDraft) {
    try {
      recordTryState(cwd, {
        slug: loaded.slug,
        recordedAt: new Date().toISOString(),
        declarationDigest: digestDeclaration(
          readFileSync(path.join(loaded.dir, "scenario.yaml"), "utf8"),
        ),
        env: overrides.env,
        mode,
        outcome: scenarioOutcome,
        assessment: assessment.kind,
        executor: executorName,
        selectors: effective.components,
        pins: state.pins,
        // Promotion refuses a run whose native differential was never
        // exercised: persisting it would make an unproven divergence look
        // proven (D10).
        baseline:
          comparisons.find((result) => result.kind === "baseline")?.status ??
          "not-run",
        reportPath,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const warning = `could not record try state for \`ass promote\`: ${detail}`;
      if (view) {
        view.warn(warning);
      } else {
        io.err(`warning: ${warning}`);
      }
    }
  }
  emit(delivered, reportPath);
  return assessment.exitCode;
}
