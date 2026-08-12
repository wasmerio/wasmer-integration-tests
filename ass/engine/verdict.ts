// Verdict evaluation (Phase 2): compute the four-way scenario outcome from
// the executor's RunOutcome and captured environment logs, and extract the
// declared evidence. Patterns are JavaScript regular expressions matched
// per line. A referenced stream that cannot be read yields `inconclusive`
// with the gap named — an unreadable log is never folded into
// not-reproduced (error-coverage row "expected log unavailable").

import { existsSync, readFileSync } from "node:fs";
import type {
  ResolvedState,
  RunOutcome,
  ScenarioOutcome,
} from "../executors/contract";
import type {
  CollectSpec,
  CombinatorNode,
  Predicate,
  Verdict,
} from "../scenario/schema";
import { classifyLogStream, type PlannedChannel } from "./capabilities";
import {
  evaluateProbe,
  type ChannelCaptures,
  type ProbeVerdict,
} from "./probe";

/** Resolves a stream name to its captured lines, or null when the stream's
 * capture does not exist. */
export type StreamReader = (stream: string) => string[] | null;

export interface EvidenceMatch {
  /** 1-based line number of the match inside the captured stream. */
  line: number;
  /** Matched line with `before`/`after` context lines around it. */
  context: string[];
}

export interface EvidenceItem {
  name: string;
  stream: string;
  pattern: string;
  /** Location of the raw capture the context was extracted from. */
  source: string | null;
  matches: EvidenceMatch[];
  note?: string;
}

export interface VerdictEvaluation {
  outcome: ScenarioOutcome;
  reproducedMatched: boolean | null;
  notReproducedMatched: boolean | null;
  /** The D11 probe reading, when the scenario declares one. */
  probe: ProbeVerdict | null;
  /** Predicate paths that matched, e.g. `verdict.reproduced_when.any[0]`. */
  matchedPredicates: string[];
  /** Streams a predicate referenced but the engine could not read. */
  unavailableStreams: string[];
  reason: string;
  evidence: EvidenceItem[];
}

const EVIDENCE_MATCH_CAP = 5;

interface EvalContext {
  read: StreamReader;
  sourceOf: (stream: string) => string | null;
  outcome: RunOutcome;
  matched: string[];
  unavailable: Set<string>;
}

function readWorkloadStream(
  outcome: RunOutcome,
  stream: "stdout" | "stderr",
): string[] | null {
  const file = outcome.logs[stream];
  if (file === undefined || !existsSync(file)) {
    return null;
  }
  return readFileSync(file, "utf8").split("\n");
}

function evalPredicate(
  predicate: Predicate,
  path: string,
  ctx: EvalContext,
): boolean {
  if ("log_matches" in predicate) {
    const { stream, pattern } = predicate.log_matches;
    const lines = ctx.read(stream);
    if (lines === null) {
      ctx.unavailable.add(stream);
      return false;
    }
    const regex = new RegExp(pattern);
    const hit = lines.some((line) => regex.test(line));
    if (hit) {
      ctx.matched.push(path);
    }
    return hit;
  }
  const { stream, pattern } = predicate.output_matches;
  const regex = new RegExp(pattern);
  const streams: Array<"stdout" | "stderr"> =
    stream === undefined ? ["stdout", "stderr"] : [stream];
  let sawAny = false;
  for (const name of streams) {
    const lines = readWorkloadStream(ctx.outcome, name);
    if (lines === null) {
      continue;
    }
    sawAny = true;
    if (lines.some((line) => regex.test(line))) {
      ctx.matched.push(path);
      return true;
    }
  }
  if (!sawAny) {
    ctx.unavailable.add(stream ?? "stdout/stderr");
  }
  return false;
}

function evalCombinator(
  node: CombinatorNode,
  path: string,
  ctx: EvalContext,
): boolean {
  const children = "any" in node ? node.any : node.all;
  const key = "any" in node ? "any" : "all";
  const results = children.map((child, i) => {
    const childPath = `${path}.${key}[${i}]`;
    if ("any" in child || "all" in child) {
      return evalCombinator(child as CombinatorNode, childPath, ctx);
    }
    return evalPredicate(child as Predicate, childPath, ctx);
  });
  return key === "any" ? results.some(Boolean) : results.every(Boolean);
}

function collectEvidence(
  name: string,
  spec: CollectSpec,
  ctx: EvalContext,
): EvidenceItem {
  const item: EvidenceItem = {
    name,
    stream: spec.stream,
    pattern: spec.pattern,
    source: ctx.sourceOf(spec.stream),
    matches: [],
  };
  const lines = ctx.read(spec.stream);
  if (lines === null) {
    item.note = `stream "${spec.stream}" was not captured`;
    return item;
  }
  const regex = new RegExp(spec.pattern);
  for (let i = 0; i < lines.length; i++) {
    if (!regex.test(lines[i])) {
      continue;
    }
    item.matches.push({
      line: i + 1,
      context: lines.slice(
        Math.max(0, i - spec.before),
        Math.min(lines.length, i + spec.after + 1),
      ),
    });
    if (item.matches.length >= EVIDENCE_MATCH_CAP) {
      item.note = `capped at the first ${EVIDENCE_MATCH_CAP} matches`;
      break;
    }
  }
  return item;
}

export interface StreamSources {
  read: StreamReader;
  /** Human-locatable origin of a stream's capture (a file path). */
  sourceOf: (stream: string) => string | null;
}

/** Build the local stream reader: platform-process streams come from the
 * compose follow log filtered by service prefix. Workload output is not a
 * log stream — `output_matches` reads it from the RunOutcome directly. */
export function localStreamSources(state: ResolvedState): StreamSources {
  const composeLines = (): string[] | null => {
    if (state.composeLogPath === null || !existsSync(state.composeLogPath)) {
      return null;
    }
    return readFileSync(state.composeLogPath, "utf8").split("\n");
  };
  const read: StreamReader = (stream) => {
    if (classifyLogStream(stream) === "platform-process") {
      const lines = composeLines();
      if (lines === null) {
        return null;
      }
      // `docker compose logs` prefixes each line with `<service>-<n>  | `.
      const prefix = new RegExp(`^${stream}-\\d+\\s+\\|`);
      return lines.filter((line) => prefix.test(line));
    }
    // App-instance streams — including the names `stdout`/`stderr`, which are
    // the *deployed app's* streams via Vector→Loki (D11), never the workload's
    // captured output (that is `output_matches`) — land with probe/app log
    // capture (Phases 4/5); the runner gates them before execution.
    return null;
  };
  const sourceOf = (stream: string): string | null => {
    if (classifyLogStream(stream) === "platform-process") {
      return state.composeLogPath;
    }
    return null;
  };
  return { read, sourceOf };
}

/** Sources for a run that has no environment logs at all: a native baseline
 * is a host process, so any `log_matches` predicate is legitimately
 * unreadable there and the baseline reads `inconclusive` rather than
 * silently passing. */
export const NO_STREAM_SOURCES: StreamSources = {
  read: () => null,
  sourceOf: () => null,
};

/** How the D11 probe is read on this run: the channels the active executor
 * and target can deliver (R5-01: *only* these are read), plus the engine's
 * own captures for non-process sources. `null` is legal only for a verdict
 * that declares no probe. */
export interface ProbeEvalContext {
  plans: readonly PlannedChannel[];
  captures?: ChannelCaptures;
}

export function evaluateVerdict(
  verdict: Verdict,
  outcome: RunOutcome,
  sources: StreamSources,
  probeCtx: ProbeEvalContext | null = null,
): VerdictEvaluation {
  if (verdict.probe !== undefined && probeCtx === null) {
    // An internal fault, not a scenario problem: every real caller knows its
    // executor and target, and silently defaulting would re-open R5-01.
    throw new Error(
      "evaluateVerdict: the verdict declares a probe but no ProbeEvalContext " +
        "was supplied",
    );
  }
  const ctx: EvalContext = {
    read: sources.read,
    sourceOf: sources.sourceOf,
    outcome,
    matched: [],
    unavailable: new Set(),
  };

  const reproducedMatched = verdict.reproduced_when
    ? evalCombinator(verdict.reproduced_when, "verdict.reproduced_when", ctx)
    : null;
  const notReproducedMatched = verdict.not_reproduced_when
    ? evalCombinator(
        verdict.not_reproduced_when,
        "verdict.not_reproduced_when",
        ctx,
      )
    : null;

  const evidence: EvidenceItem[] = [];
  for (const entry of verdict.collect ?? []) {
    for (const [name, spec] of Object.entries(entry)) {
      evidence.push(collectEvidence(name, spec, ctx));
    }
  }

  // The probe (D11) is the scenario's own positive health proof: it states
  // reproduced *or* not-reproduced explicitly, which is why a probe scenario
  // needs no not_reproduced_when block.
  const probe =
    verdict.probe === undefined || probeCtx === null
      ? null
      : evaluateProbe(probeCtx.plans, outcome, probeCtx.captures ?? {});

  const unavailableStreams = Array.from(ctx.unavailable).sort();
  let outcomeKind: ScenarioOutcome;
  let reason: string;
  if (reproducedMatched === true) {
    outcomeKind = "reproduced";
    reason = `matched ${ctx.matched.join(", ")}`;
  } else if (probe !== null && probe.outcome === "reproduced") {
    outcomeKind = "reproduced";
    reason = probe.reason;
  } else if (probe !== null && probe.outcome === "inconclusive") {
    // Silence, disagreement, a backstop kill or an exit-status contradiction:
    // each is a reason the probe cannot be believed, never health.
    outcomeKind = "inconclusive";
    reason = probe.reason;
  } else if (unavailableStreams.length > 0) {
    // A predicate referenced a stream the engine could not read; claiming
    // not-reproduced would launder the gap into a health signal.
    outcomeKind = "inconclusive";
    reason =
      "verdict predicate(s) referenced unavailable stream(s): " +
      unavailableStreams.join(", ");
  } else if (probe !== null) {
    outcomeKind = "not-reproduced";
    reason = probe.reason;
  } else if (notReproducedMatched === true) {
    outcomeKind = "not-reproduced";
    reason = "not_reproduced_when matched (positive health proof)";
  } else if (notReproducedMatched === false) {
    outcomeKind = "inconclusive";
    reason =
      "neither reproduced_when nor the declared not_reproduced_when " +
      "matched; never folded into not-reproduced";
  } else if (outcome.timedOut === true) {
    // Without a probe there is nothing that distinguishes "the workload was
    // healthy" from "the workload never finished".
    outcomeKind = "inconclusive";
    reason =
      "reproduced_when did not match, but the executor's backstop timeout " +
      "killed the workload; a hang is never folded into not-reproduced";
  } else {
    outcomeKind = "not-reproduced";
    reason = "reproduced_when did not match";
  }

  return {
    outcome: outcomeKind,
    reproducedMatched,
    notReproducedMatched,
    probe,
    matchedPredicates: ctx.matched,
    unavailableStreams,
    reason,
    evidence,
  };
}
