// Engine-owned capability table (D7) and verdict preflight: an unevaluable
// predicate fails before fixture resolution, never silently skipped.
// App instance streams ride Vector→Loki and evaluate everywhere (D11);
// platform process streams (edge, backend) are local-only pending adapters.

import { PreflightError } from "../errors";
import type { TargetEnv } from "../executors/contract";
import { findExecutor, LOAD_EXECUTORS } from "../executors/registry";
import { checkReference, templateReferences } from "../executors/template";
import { channelLabel } from "./probe";
import { baselineSpecOf } from "../scenario/schema";
import type {
  CombinatorNode,
  Predicate,
  ProbeChannel,
  Scenario,
  Verdict,
} from "../scenario/schema";

export type PredicateClass = "executor-observable" | "environment-observable";

const APP_INSTANCE_STREAMS = new Set(["app", "stdout", "stderr"]);
const PLATFORM_PROCESS_STREAMS = new Set(["edge", "backend"]);

const KNOWN_STREAMS_HELP =
  "known streams: app, stdout, stderr (app instance, evaluable everywhere); " +
  "edge, backend (platform process, local-only)";

export type LogStreamClass = "app-instance" | "platform-process" | "unknown";

export function classifyLogStream(stream: string): LogStreamClass {
  if (APP_INSTANCE_STREAMS.has(stream)) {
    return "app-instance";
  }
  if (PLATFORM_PROCESS_STREAMS.has(stream)) {
    return "platform-process";
  }
  return "unknown";
}

export interface CollectedPredicate {
  path: string;
  predicate: Predicate;
  class: PredicateClass;
  stream?: string;
}

export { PreflightError };

export function classifyPredicate(predicate: Predicate): PredicateClass {
  return "log_matches" in predicate
    ? "environment-observable"
    : "executor-observable";
}

export function isLogStreamEvaluable(stream: string, env: TargetEnv): boolean {
  switch (classifyLogStream(stream)) {
    case "app-instance":
      return true;
    case "platform-process":
      return env === "local";
    case "unknown":
      return false;
  }
}

/** Where a declared channel's bytes come from on this run. `process-capture`
 * is the executor's own stdout/stderr files; `app-logs` is the deployed
 * probe's instance stream over Vector→Loki (`wasmer app logs`, D14-windowed);
 * `http-fetch` is the engine's own GET against the deployed probe. */
export type ChannelSource = "process-capture" | "app-logs" | "http-fetch";

export interface PlannedChannel {
  channel: ProbeChannel;
  source: ChannelSource;
}

/** The channels the active executor and target can actually deliver, each
 * with its source. A process executor's `log` channel is its own capture; an
 * HTTP executor delivers `log` only where the probe is deployed as an app
 * (remote targets), and `http` likewise. Declared channels with no source
 * here are inert, not errors — that is what lets one verdict serve both the
 * `raw-wasmer` and the `artillery-http` profile — and *only* planned
 * channels are ever read, so an HTTP run's own stderr can never masquerade
 * as the probe's (review 5, R5-01). */
export function planChannels(
  channels: readonly ProbeChannel[],
  executorName: string,
  env: TargetEnv,
): PlannedChannel[] {
  const executor = findExecutor(executorName);
  if (executor === null) {
    return [];
  }
  const remote = env !== "local";
  const plans: PlannedChannel[] = [];
  for (const channel of channels) {
    if (channel.type === "log") {
      if (executor.probeChannels.includes("log")) {
        plans.push({ channel, source: "process-capture" });
      } else if (remote) {
        plans.push({ channel, source: "app-logs" });
      }
    } else if (remote && executor.probeChannels.includes("http")) {
      plans.push({ channel, source: "http-fetch" });
    }
  }
  return plans;
}

function walkCombinator(
  node: CombinatorNode,
  path: string,
  out: CollectedPredicate[],
): void {
  const children = "any" in node ? node.any : node.all;
  const key = "any" in node ? "any" : "all";
  children.forEach((child, i) => {
    const childPath = `${path}.${key}[${i}]`;
    if ("any" in child || "all" in child) {
      walkCombinator(child as CombinatorNode, childPath, out);
      return;
    }
    const predicate = child as Predicate;
    out.push({
      path: childPath,
      predicate,
      class: classifyPredicate(predicate),
      stream:
        "log_matches" in predicate ? predicate.log_matches.stream : undefined,
    });
  });
}

export function collectPredicates(verdict: Verdict): CollectedPredicate[] {
  const out: CollectedPredicate[] = [];
  if (verdict.reproduced_when) {
    walkCombinator(verdict.reproduced_when, "verdict.reproduced_when", out);
  }
  if (verdict.not_reproduced_when) {
    walkCombinator(
      verdict.not_reproduced_when,
      "verdict.not_reproduced_when",
      out,
    );
  }
  return out;
}

/** A pattern that does not compile is statically unevaluable (D7): failing
 * it here costs nothing; failing it after the workload burns a full boot. */
function patternError(pattern: string): string | null {
  try {
    new RegExp(pattern);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Everything about the active load profile that is decidable from the
 * declaration alone: the executor must exist, its profile must parse, every
 * `{{ … }}` it interpolates must name something the scenario can produce,
 * and every fixture it consumes must accept it. All of it fails before a
 * fixture is resolved — a six-minute boot is too expensive to spend on a
 * typo. */
export function preflightLoad(
  scenario: Scenario,
  profileName: string,
  env: TargetEnv,
): void {
  const executorName = scenario.load.executors[profileName] ?? profileName;
  const executor = LOAD_EXECUTORS.find(
    (candidate) => candidate.name === executorName,
  );
  if (executor === undefined) {
    throw new PreflightError(
      `unknown executor "${executorName}"; a load profile is named after the ` +
        "executor that runs it, or names one with executor:. Known " +
        "executors: " +
        LOAD_EXECUTORS.map((candidate) => candidate.name)
          .sort()
          .join(", "),
    );
  }
  const profile = scenario.load.profiles[profileName];
  executor.parseProfile(profile);

  const lines: string[] = [];
  let needsDeployment = false;
  for (const reference of templateReferences(profile)) {
    const check = checkReference(scenario, reference);
    if (check.problem !== null) {
      lines.push(`  {{ ${reference} }} ${check.problem}`);
    }
    needsDeployment ||= check.needsDeployment;
  }

  // Fixture/executor compatibility (QA-637): a probe packaged for
  // `wasmer run` cannot be driven by an HTTP load generator, and saying so
  // here is cheaper than a confusing empty result later.
  for (const [name, fixture] of [
    ...Object.entries(scenario.fixtures.apps ?? {}),
    ...Object.entries(scenario.fixtures.probes ?? {}),
  ]) {
    // A fixture may name either the profile or the executor behind it, so a
    // second profile of the same executor does not need re-listing.
    const allowed = fixture.executors;
    if (
      allowed !== undefined &&
      !allowed.includes(profileName) &&
      !allowed.includes(executorName)
    ) {
      lines.push(
        `  fixture "${name}" declares executors: ${allowed.join(", ")}, ` +
          `which does not include the active profile "${profileName}"` +
          (executorName === profileName ? "" : ` (executor "${executorName}")`),
      );
    }
  }

  if (lines.length > 0) {
    throw new PreflightError(
      `load profile "${profileName}" cannot run as declared; ` +
        "no fixtures were resolved:\n" +
        lines.join("\n"),
    );
  }
  if (needsDeployment && env === "local") {
    // `.url`/`.app_id` mean the fixture has to exist as a deployed app.
    // Apps deploy locally; probes deploy on remote targets (D9, Phase 5) —
    // the local stack has no harness-owned probe deployment.
    const probes = new Set(Object.keys(scenario.fixtures.probes ?? {}));
    const deployedProbes = templateReferences(profile)
      .filter((reference) => {
        const head = reference.split(".")[0];
        const tail = reference.slice(head.length + 1);
        return probes.has(head) && (tail === "url" || tail === "app_id");
      })
      .sort();
    if (deployedProbes.length > 0) {
      throw new PreflightError(
        `load profile "${profileName}" references ` +
          `${deployedProbes.map((r) => `{{ ${r} }}`).join(", ")}, and the ` +
          "harness deploys probes on remote targets only " +
          "(--env dev|bugtopia|prod, D9); on local, run the probe through " +
          "a process executor (raw-wasmer)",
      );
    }
  }
}

export function preflightVerdict(
  scenario: Scenario,
  env: TargetEnv,
  profileName: string,
): void {
  const executorName = scenario.load.executors[profileName] ?? profileName;
  const verdict = scenario.verdict;
  if (verdict === undefined) {
    return;
  }
  const lines: string[] = [];
  for (const p of collectPredicates(verdict)) {
    const pattern =
      "log_matches" in p.predicate
        ? p.predicate.log_matches.pattern
        : p.predicate.output_matches.pattern;
    const invalid = patternError(pattern);
    if (invalid !== null) {
      lines.push(`  ${p.path}: ${invalid}`);
    }
    if (
      p.class !== "environment-observable" ||
      p.stream === undefined ||
      isLogStreamEvaluable(p.stream, env)
    ) {
      continue;
    }
    lines.push(
      classifyLogStream(p.stream) === "unknown"
        ? `  ${p.path}: log_matches on unknown stream "${p.stream}" ` +
            `is not evaluable on any target; ${KNOWN_STREAMS_HELP}`
        : `  ${p.path}: log_matches on platform process stream ` +
            `"${p.stream}" is not evaluable on target "${env}" (local-only ` +
            "until remote log adapters land, QA-640 follow-up)",
    );
  }
  // Evidence streams follow the same log-stream capability rules: evidence
  // that cannot be collected on the target is a preflight failure, not a
  // silently empty report.
  (verdict.collect ?? []).forEach((entry, i) => {
    for (const [name, spec] of Object.entries(entry)) {
      const invalid = patternError(spec.pattern);
      if (invalid !== null) {
        lines.push(`  verdict.collect[${i}].${name}: ${invalid}`);
      }
      if (isLogStreamEvaluable(spec.stream, env)) {
        continue;
      }
      lines.push(
        classifyLogStream(spec.stream) === "unknown"
          ? `  verdict.collect[${i}].${name}: unknown stream ` +
              `"${spec.stream}"; ${KNOWN_STREAMS_HELP}`
          : `  verdict.collect[${i}].${name}: platform process stream ` +
              `"${spec.stream}" is not evaluable on target "${env}" ` +
              "(local-only until remote log adapters land, QA-640 follow-up)",
      );
    }
  });
  // A probe verdict needs at least one channel the active executor can
  // deliver *and* the engine can read on this target. Channels the executor
  // does not carry stay inert so the same verdict serves every declared
  // profile.
  const channels = verdict.probe?.channels ?? [];
  if (
    channels.length > 0 &&
    planChannels(channels, executorName, env).length === 0
  ) {
    const declared = channels.map(channelLabel).join(", ");
    lines.push(
      `  verdict.probe: none of the declared channels (${declared}) can ` +
        `carry a verdict under executor "${executorName}" on target ` +
        `"${env}"` +
        (env === "local"
          ? "; deployed-probe channels (http, or log under an HTTP " +
            "executor) need a remote target, where the harness deploys " +
            "the probe as an app (D9)"
          : ""),
    );
  }

  // D10: the baseline is a host process, so it can only be judged from
  // executor-observable evidence. A verdict that decides solely on platform
  // logs cannot judge one, and silently scoring it `inconclusive` after the
  // fact would look like a broken probe rather than a declaration gap.
  const baseline = verdict.baseline;
  if (baseline !== undefined && baselineSpecOf(baseline) !== null) {
    const judgeable =
      verdict.probe !== undefined ||
      collectPredicates(verdict).some(
        (predicate) => predicate.class === "executor-observable",
      );
    if (!judgeable) {
      lines.push(
        "  verdict.baseline: the native baseline is a host process, so it " +
          "can only be judged by verdict.probe or an output_matches " +
          "predicate; this verdict decides on environment logs alone. " +
          "Declare one, or waive the baseline with a reason (D10)",
      );
    }
  }

  if (lines.length > 0) {
    throw new PreflightError(
      `verdict preflight failed for target "${env}"; ` +
        "no fixtures were resolved:\n" +
        lines.join("\n"),
    );
  }
}
