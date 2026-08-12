// Probe verdict contract (D11). A self-verdicting repro states its own result
// in one line instead of making every scenario invent grep patterns:
//
//   ASS-VERDICT: reproduced 4 primitive(s) broken
//   ASS-VERDICT: not-reproduced all primitives ok
//   ASS-VERDICT: inconclusive matrix incomplete
//
// Exactly one *logical* verdict: none means the probe never judged, and
// disagreeing tokens mean it judged twice — both are `inconclusive`, because
// silence is not health. Repeated identical lines are tolerated; retries and
// tee'd streams happen.
//
// Exit codes are deliberately not a channel: eight bits with colonised
// semantics that wrappers munge, and absent over HTTP. They serve as a
// consistency cross-check — a process that dies while claiming health is
// telling two different stories, and the run says so instead of picking one.

import { existsSync, readFileSync } from "node:fs";
import type { RunOutcome, ScenarioOutcome } from "../executors/contract";
import type { ProbeChannel } from "../scenario/schema";
import type { PlannedChannel } from "./capabilities";

export const MARKER_PREFIX = "ASS-VERDICT:";

const MARKER = /ASS-VERDICT:[ \t]*([^\s]+)[ \t]*(.*)$/;

const PROBE_OUTCOMES = new Set<string>([
  "reproduced",
  "not-reproduced",
  "inconclusive",
]);

export interface ProbeReading {
  /** The channel the lines came from, e.g. `log:stderr`. */
  channel: string;
  /** Present only when the channel could be read at all. */
  available: boolean;
  /** Distinct outcome tokens seen, in order of first appearance. */
  tokens: string[];
  /** Detail text from the first marker line. */
  detail: string;
  /** Every marker line, verbatim, for the report. */
  lines: string[];
  /** Tokens that are not one of the three outcomes. */
  malformed: string[];
}

export function readMarkers(lines: string[], channel: string): ProbeReading {
  const reading: ProbeReading = {
    channel,
    available: true,
    tokens: [],
    detail: "",
    lines: [],
    malformed: [],
  };
  for (const line of lines) {
    const match = MARKER.exec(line);
    if (match === null) {
      continue;
    }
    reading.lines.push(line.trim());
    const token = match[1];
    if (!PROBE_OUTCOMES.has(token)) {
      if (!reading.malformed.includes(token)) {
        reading.malformed.push(token);
      }
      continue;
    }
    if (reading.tokens.length === 0) {
      reading.detail = match[2].trim();
    }
    if (!reading.tokens.includes(token)) {
      reading.tokens.push(token);
    }
  }
  return reading;
}

export function channelLabel(channel: ProbeChannel): string {
  return channel.type === "log"
    ? `log:${channel.stream}`
    : `http:${channel.match}`;
}

/** Files the engine captured for non-process channel sources, keyed by
 * channel label (`log:stderr`, `http:body`): the D14-windowed app-log pull
 * and the engine's own GET against the deployed probe. */
export type ChannelCaptures = Record<string, string>;

/** Read one *planned* channel out of a completed workload. Only planned
 * channels are ever read (R5-01): a `process-capture` plan reads the
 * executor's own stream files, everything else reads the engine's capture
 * for that channel. Returns an unavailable reading when the source produced
 * nothing at all — an unreadable channel must never look like a probe that
 * stayed silent. */
export function readChannel(
  plan: PlannedChannel,
  outcome: RunOutcome,
  captures: ChannelCaptures = {},
): ProbeReading {
  const label = channelLabel(plan.channel);
  const file =
    plan.source === "process-capture"
      ? plan.channel.type === "log"
        ? outcome.logs[plan.channel.stream]
        : undefined
      : captures[label];
  if (file === undefined || !existsSync(file)) {
    return {
      channel: label,
      available: false,
      tokens: [],
      detail: "",
      lines: [],
      malformed: [],
    };
  }
  return readMarkers(readFileSync(file, "utf8").split("\n"), label);
}

export interface ProbeVerdict {
  outcome: ScenarioOutcome;
  reason: string;
  /** Channels that produced a marker, for the report. */
  channels: string[];
  /** Marker lines seen anywhere, for the report. */
  lines: string[];
}

/** Combine every planned channel into one probe verdict, then cross-check it
 * against how the process ended. */
export function evaluateProbe(
  plans: readonly PlannedChannel[],
  outcome: RunOutcome,
  captures: ChannelCaptures = {},
): ProbeVerdict {
  const readings = plans.map((plan) => readChannel(plan, outcome, captures));
  const available = readings.filter((reading) => reading.available);
  const tokens: string[] = [];
  const lines: string[] = [];
  const malformed: string[] = [];
  const sources: string[] = [];
  for (const reading of available) {
    lines.push(...reading.lines);
    for (const token of reading.tokens) {
      if (!tokens.includes(token)) {
        tokens.push(token);
      }
    }
    for (const token of reading.malformed) {
      if (!malformed.includes(token)) {
        malformed.push(token);
      }
    }
    if (reading.lines.length > 0) {
      sources.push(reading.channel);
    }
  }

  const inconclusive = (reason: string): ProbeVerdict => ({
    outcome: "inconclusive",
    reason,
    channels: sources,
    lines,
  });

  if (available.length === 0) {
    return inconclusive(
      "no declared probe channel could be read " +
        `(${readings.map((reading) => reading.channel).join(", ")})`,
    );
  }
  if (outcome.timedOut === true) {
    // The backstop fired: whatever the probe managed to say, it did not get
    // to finish saying it.
    return inconclusive(
      "the harness backstop timeout killed the probe; a hang is never " +
        "folded into not-reproduced",
    );
  }
  if (tokens.length === 0) {
    return inconclusive(
      malformed.length > 0
        ? `the probe emitted ${MARKER_PREFIX} with unrecognized outcome ` +
            `token(s) ${malformed.join(", ")}; expected reproduced, ` +
            "not-reproduced or inconclusive"
        : `the probe emitted no ${MARKER_PREFIX} line on ` +
            `${available.map((reading) => reading.channel).join(", ")}, ` +
            "so it never judged",
    );
  }
  if (tokens.length > 1) {
    return inconclusive(
      `the probe emitted conflicting ${MARKER_PREFIX} outcomes ` +
        `(${tokens.join(", ")}); exactly one logical verdict is required`,
    );
  }

  const token = tokens[0] as ScenarioOutcome;
  const detail = available.find((reading) => reading.detail !== "")?.detail;
  const stated = `probe reported ${token}${detail ? ` — ${detail}` : ""} on ${sources.join(", ")}`;

  // Cross-check: a probe claiming health while its process died is telling
  // two stories, and the harness must not pick the flattering one.
  const died =
    (outcome.exitCode !== undefined && outcome.exitCode !== 0) ||
    (outcome.signal !== undefined && outcome.signal !== null);
  if (token === "not-reproduced" && died) {
    const how =
      outcome.signal !== undefined && outcome.signal !== null
        ? `died by signal ${outcome.signal}`
        : `exited ${outcome.exitCode}`;
    return inconclusive(
      `${stated}, but the process ${how}: the verdict line and the exit ` +
        "status contradict each other",
    );
  }
  return { outcome: token, reason: stated, channels: sources, lines };
}
