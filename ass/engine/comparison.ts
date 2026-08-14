// Baselines and controls (D8/D10): the runs that turn "the probe failed
// under Wasmer" into "this is a Wasmer bug".
//
// A baseline is the distinguished member — the same probe on the native
// engine, expected not to reproduce. A violated baseline means the probe is
// broken or the bug is not Wasmer's, and either way no claim stands: the run
// ends `inconclusive` rather than reporting a reproduction nobody can act on.
// A missing engine is different in kind — the differential was not attempted,
// so the run is marked degraded and keeps its main outcome, and `ass promote`
// refuses to persist it.

import { spawnSync } from "node:child_process";
import type { ResolvedState, ScenarioOutcome } from "../executors/contract";
import {
  baselineSpecOf,
  type Scenario,
  type Verdict,
} from "../scenario/schema";
import {
  engineProbeArgv,
  executeHostProcess,
  type BaselineEngine,
} from "../executors/hostProcess";
import { assertRunOutcome, resolveExecutor } from "../executors/registry";
import type { ExecuteContext } from "../executors/contract";
import { evaluateVerdict, NO_STREAM_SOURCES } from "./verdict";
import { planChannels } from "./capabilities";

export type ComparisonStatus =
  "ok" | "waived" | "engine-missing" | "not-run" | "failed";

export interface ComparisonResult {
  /** "baseline", or the control's declared name. */
  name: string;
  kind: "baseline" | "control";
  runner: string;
  status: ComparisonStatus;
  expected: ScenarioOutcome | null;
  observed: ScenarioOutcome | null;
  /** True only when the comparison ran and disagreed with `expected`. */
  violated: boolean;
  detail: string;
  logs: Record<string, string>;
}

/** Is the engine installed on this host? Injected so the whole table stays
 * deterministic in tests. */
export type EnginePresence = (engine: BaselineEngine) => boolean;

const defaultEnginePresence: EnginePresence = (engine) => {
  const argv = engineProbeArgv(engine);
  if (argv.length === 0) {
    return true; // engine "binary" carries its own command
  }
  const result = spawnSync(argv[0], argv.slice(1), {
    stdio: "ignore",
    encoding: "utf8",
  });
  return result.error === undefined && result.status === 0;
};

export interface ComparisonDeps extends ExecuteContext {
  enginePresence?: EnginePresence;
}

interface NativeSpec {
  engine: BaselineEngine;
  command?: string[];
  entry: string[];
  workdir?: string;
  expect: ScenarioOutcome;
}

/** Judge a comparison run with the scenario's own verdict machinery, minus
 * the environment logs a host process cannot produce. The probe channels are
 * planned for the executor that actually ran the comparison (R5-01) on the
 * local target: baselines and controls are local processes, so a channel
 * needing a deployed probe is legitimately unavailable here and reads
 * `inconclusive` rather than silently passing. */
function judge(
  verdict: Verdict,
  outcome: Parameters<typeof evaluateVerdict>[1],
  executorName: string,
): { outcome: ScenarioOutcome; reason: string } {
  const probeCtx =
    verdict.probe === undefined
      ? null
      : {
          plans: planChannels(verdict.probe.channels, executorName, "local"),
        };
  const evaluation = evaluateVerdict(
    verdict,
    outcome,
    NO_STREAM_SOURCES,
    probeCtx,
  );
  return { outcome: evaluation.outcome, reason: evaluation.reason };
}

async function runNative(
  name: string,
  kind: ComparisonResult["kind"],
  spec: NativeSpec,
  verdict: Verdict,
  state: ResolvedState,
  deps: ComparisonDeps,
): Promise<ComparisonResult> {
  const present = (deps.enginePresence ?? defaultEnginePresence)(spec.engine);
  const base = {
    name,
    kind,
    runner: `host-process:${spec.engine}`,
    expected: spec.expect,
  };
  if (!present) {
    return {
      ...base,
      status: "engine-missing",
      observed: null,
      violated: false,
      detail:
        `baseline not exercised: engine "${spec.engine}" is not installed ` +
        "on this host, so the native differential was not attempted " +
        "(`ass doctor` lists baseline engines)",
      logs: {},
    };
  }
  let outcome;
  try {
    outcome = assertRunOutcome(
      await executeHostProcess(
        {
          engine: spec.engine,
          ...(spec.command === undefined ? {} : { command: spec.command }),
          entry: spec.entry,
          ...(spec.workdir === undefined ? {} : { workdir: spec.workdir }),
        },
        state,
        {
          ...deps,
          label: kind === "baseline" ? "baseline" : `control-${name}`,
        },
      ),
      "host-process",
    );
  } catch (err) {
    return {
      ...base,
      status: "failed",
      observed: null,
      violated: false,
      detail: `could not run: ${err instanceof Error ? err.message : String(err)}`,
      logs: {},
    };
  }
  const judged = judge(verdict, outcome, "host-process");
  return {
    ...base,
    status: "ok",
    observed: judged.outcome,
    violated: judged.outcome !== spec.expect,
    detail: judged.reason,
    logs: outcome.logs,
  };
}

async function runProfileControl(
  name: string,
  profileName: string,
  expect: ScenarioOutcome,
  scenario: Scenario,
  verdict: Verdict,
  state: ResolvedState,
  deps: ComparisonDeps,
): Promise<ComparisonResult> {
  const base = {
    name,
    kind: "control" as const,
    runner: profileName,
    expected: expect,
  };
  let outcome;
  const executorName = scenario.load.executors[profileName] ?? profileName;
  try {
    const executor = resolveExecutor(executorName);
    outcome = assertRunOutcome(
      await executor.execute(scenario.load.profiles[profileName], state, {
        ...deps,
        // Controls must not overwrite the measured workload's captured logs.
        label: `control-${name}`,
      }),
      executorName,
    );
  } catch (err) {
    return {
      ...base,
      status: "failed",
      observed: null,
      violated: false,
      detail: `could not run: ${err instanceof Error ? err.message : String(err)}`,
      logs: {},
    };
  }
  const judged = judge(verdict, outcome, executorName);
  return {
    ...base,
    status: "ok",
    observed: judged.outcome,
    violated: judged.outcome !== expect,
    detail: judged.reason,
    logs: outcome.logs,
  };
}

/** Run the declared baseline and controls after the measured workload. They
 * are local processes and cheap even for remote-target runs, so they are not
 * something a run opts into. */
export async function runComparisons(
  scenario: Scenario,
  state: ResolvedState,
  deps: ComparisonDeps,
): Promise<ComparisonResult[]> {
  const verdict = scenario.verdict;
  if (verdict === undefined) {
    return [];
  }
  const results: ComparisonResult[] = [];

  const baseline = verdict.baseline;
  if (baseline !== undefined) {
    const spec = baselineSpecOf(baseline);
    if (spec === null) {
      results.push({
        name: "baseline",
        kind: "baseline",
        runner: "waived",
        status: "waived",
        expected: null,
        observed: null,
        violated: false,
        detail: (baseline as { waived: string }).waived,
        logs: {},
      });
    } else {
      results.push(
        await runNative(
          "baseline",
          "baseline",
          {
            engine: spec.engine,
            command: spec.command,
            entry: spec.entry,
            workdir: spec.workdir,
            expect: spec.expect,
          },
          verdict,
          state,
          deps,
        ),
      );
    }
  }

  for (const [name, control] of Object.entries(verdict.controls ?? {})) {
    if (control.engine !== undefined) {
      results.push(
        await runNative(
          name,
          "control",
          {
            engine: control.engine,
            command: control.command,
            entry: control.entry ?? [],
            workdir: control.workdir,
            expect: control.expect,
          },
          verdict,
          state,
          deps,
        ),
      );
      continue;
    }
    results.push(
      await runProfileControl(
        name,
        control.executor as string,
        control.expect,
        scenario,
        verdict,
        state,
        deps,
      ),
    );
  }
  return results;
}

export interface ComparisonSummary {
  /** Comparisons that ran and disagreed with what they were declared to do. */
  violations: ComparisonResult[];
  /** Comparisons that could not run: the differential was not attempted. */
  degraded: ComparisonResult[];
}

export function summarizeComparisons(
  results: ComparisonResult[],
): ComparisonSummary {
  return {
    violations: results.filter((result) => result.violated),
    degraded: results.filter(
      (result) =>
        result.status === "engine-missing" || result.status === "failed",
    ),
  };
}
