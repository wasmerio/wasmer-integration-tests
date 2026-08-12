// Machine-readable run report + human summary (QA-641 slice needed by
// Phase 2; the full report writer with scheduling metadata lands in
// Phase 6). Identifies scenario, fixture versions, executor, target env,
// outcome, assessment, and retained evidence.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type {
  RunOutcome,
  ScenarioOutcome,
  TargetEnv,
} from "../executors/contract";
import type { Assessment, AssessmentKind, RunMode } from "../engine/assessment";
import {
  colorEnabled,
  fade,
  makeStyle,
  stripAnsi,
  colorDepth,
  GUTTER,
  pairs,
  tint,
  wrap,
  FRAME_RGB,
  truncate,
  KEY_RGB,
  type ColorDepth,
  type ColorName,
  type Style,
} from "./style";
import type { VerdictEvaluation } from "../engine/verdict";
import type { ComparisonResult } from "../engine/comparison";
import type { Lifecycle } from "../scenario/schema";

/** Wall-clock accounting for the run's phases. A repro is run repeatedly
 * while investigating, so where the minutes go is first-class data, not
 * something to re-derive from scattered logs. */
export interface PhaseTiming {
  name: "setup" | "workload" | "collect" | "comparison" | "cleanup";
  startedAt: string;
  finishedAt: string;
  seconds: number;
}

export interface RunTiming {
  startedAt: string;
  finishedAt: string;
  seconds: number;
  phases: PhaseTiming[];
}

export interface RunReport {
  /** Baseline and control runs and what they proved (D8/D10). */
  comparisons?: ComparisonResult[];
  /** Human-readable notes about what this run could *not* establish — a
   * missing baseline engine above all. A degraded run is still a run; it
   * just cannot be promoted. */
  degraded?: string[];
  scenario: {
    id: string;
    title: string;
    slug: string;
    lifecycle: Lifecycle;
  };
  target: { env: TargetEnv; mode: RunMode };
  /** Effective selectors (declaration + overrides) per component. */
  selectors: Record<string, string>;
  /** Concrete versions the selectors resolved to. */
  components: Record<string, string>;
  executor: { name: string; profile: Record<string, unknown> } | null;
  outcome: ScenarioOutcome;
  assessment: Assessment;
  verdict: Omit<VerdictEvaluation, "outcome" | "evidence"> | null;
  evidence: VerdictEvaluation["evidence"];
  workload: Pick<
    RunOutcome,
    | "startedAt"
    | "finishedAt"
    | "exitCode"
    | "signal"
    | "timedOut"
    | "command"
    | "counters"
    | "logs"
  > | null;
  timing: RunTiming;
  /** Setup failure detail; only set when outcome is setup-failed. */
  setupFailure: string | null;
  /** What the chained tools said that looked like trouble. Restated in the
   * summary because by then it has scrolled out of view. */
  diagnosis: string[];
  /** Cleanup errors surfaced without masking the run outcome. */
  cleanupErrors: string[];
}

// Schema-validated on the load-bearing spine (QA-641): the fields audit,
// pipelines and humans route on are strict; free-form payloads (executor
// profiles, comparison details, counters) stay open so a new executor field
// never invalidates old reports.
const runReportSchema = z.object({
  comparisons: z.array(z.record(z.unknown())).optional(),
  degraded: z.array(z.string()).optional(),
  scenario: z.object({
    id: z.string().min(1),
    title: z.string(),
    slug: z.string().min(1),
    lifecycle: z.unknown(),
  }),
  target: z.object({
    env: z.enum(["local", "dev", "bugtopia", "prod"]),
    mode: z.enum(["pinned", "floating"]),
  }),
  selectors: z.record(z.string()),
  components: z.record(z.string()),
  executor: z
    .object({ name: z.string().min(1), profile: z.record(z.unknown()) })
    .nullable(),
  outcome: z.enum([
    "reproduced",
    "not-reproduced",
    "inconclusive",
    "setup-failed",
  ]),
  assessment: z.object({
    kind: z.enum([
      "expected",
      "informational",
      "candidate-fix",
      "alert",
      "inconclusive",
      "setup-failed",
    ]),
    exitCode: z.number().int().min(0).max(4),
    alerting: z.boolean(),
    reason: z.string(),
  }),
  verdict: z.record(z.unknown()).nullable(),
  evidence: z.array(z.record(z.unknown())),
  workload: z
    .object({
      startedAt: z.string().min(1),
      finishedAt: z.string().min(1),
      exitCode: z.number().optional(),
      signal: z.string().nullable().optional(),
      timedOut: z.boolean().optional(),
      command: z.array(z.string()).optional(),
      counters: z.record(z.number()).optional(),
      logs: z.record(z.string()),
    })
    .nullable(),
  timing: z.object({
    startedAt: z.string(),
    finishedAt: z.string(),
    seconds: z.number(),
    phases: z.array(
      z.object({
        name: z.enum(["setup", "workload", "collect", "comparison", "cleanup"]),
        startedAt: z.string(),
        finishedAt: z.string(),
        seconds: z.number(),
      }),
    ),
  }),
  setupFailure: z.string().nullable(),
  diagnosis: z.array(z.string()),
  cleanupErrors: z.array(z.string()),
});

/** Deep-copy `report` with every occurrence of a secret value replaced.
 * Evidence excerpts and diagnosis lines quote captured logs, and captured
 * logs can quote anything — so redaction runs over the whole value tree,
 * not just fields somebody remembered to name. */
export function redactReport(
  report: RunReport,
  secrets: readonly string[],
): RunReport {
  const meaningful = secrets.filter((secret) => secret.length >= 6);
  if (meaningful.length === 0) {
    return report;
  }
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      for (const secret of meaningful) {
        out = out.split(secret).join("[redacted]");
      }
      return out;
    }
    if (Array.isArray(value)) {
      return value.map(scrub);
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        out[key] = scrub(child);
      }
      return out;
    }
    return value;
  };
  return scrub(report) as RunReport;
}

/** Values worth scrubbing out of a report: whatever the identity flow put
 * under a sensitive-looking env key. */
export function secretsOf(execEnv: Record<string, string>): string[] {
  return Object.entries(execEnv)
    .filter(([key]) => /token|secret|password|api[-_]?key/i.test(key))
    .map(([, value]) => value);
}

export function writeReport(reportPath: string, report: RunReport): void {
  const checked = runReportSchema.safeParse(report);
  if (!checked.success) {
    // An internal fault, not a scenario problem: the engine built a report
    // that does not satisfy its own contract.
    throw new Error(
      `internal: run report failed schema validation:\n` +
        checked.error.issues
          .map(
            (issue) =>
              `  ${issue.path.join(".") || "(root)"}: ${issue.message}`,
          )
          .join("\n"),
    );
  }
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}

/** Glyph and accent per assessment: the eye should land on the verdict and
 * know whether to care before reading a word. */
const ASSESSMENT_STYLE: Record<
  AssessmentKind,
  { glyph: string; color: ColorName }
> = {
  expected: { glyph: "✔", color: "green" },
  informational: { glyph: "●", color: "cyan" },
  "candidate-fix": { glyph: "✔", color: "cyan" },
  alert: { glyph: "✖", color: "red" },
  inconclusive: { glyph: "▲", color: "yellow" },
  "setup-failed": { glyph: "✖", color: "red" },
};

// `<service>-<n>  | <rfc3339> message` — compose scaffolding repeated on
// every line. The stream is already named in the evidence header, so the
// prefix only steals width from the message that matters. Indentation after
// the timestamp is preserved: panic dumps align `left:`/`right:` with it.
const LOG_PREFIX_PATTERN = /^\S+-\d+\s*\|\s*(?:\S+Z[ \t])?/;

export interface SummaryOptions {
  color?: boolean;
  width?: number;
  /** Report paths under this directory print relative. */
  cwd?: string;
  /** Palette available for the fading rule; defaults to sniffing the env. */
  depth?: ColorDepth;
  /** The presenter already drew the banner and opened the table: skip the
   * header and start straight at a divider. */
  continued?: boolean;
}

/** A keyed block: the first line sits beside its key, the rest hang under it,
 * and `null` opens a breathing gap without breaking the rule. */
interface Block {
  key: string;
  lines: (string | null)[];
}

export function formatSummary(
  report: RunReport,
  reportPath: string,
  options: SummaryOptions = {},
): string[] {
  const s = makeStyle(options.color ?? colorEnabled());
  const width = Math.max(40, Math.min(options.width ?? terminalWidth(), 120));
  const { glyph, color } = ASSESSMENT_STYLE[report.assessment.kind];

  // A real two-column table: keys right-aligned against a vertical rule, so
  // the eye tracks one edge instead of scanning a uniform block. The frame
  // (rule, keys, separators) is blue; values keep the terminal foreground,
  // and colour beyond that is reserved for what the run actually did.
  const gutter = GUTTER;
  const depth = options.depth ?? colorDepth();
  const valueWidth = width - gutter - 5;
  const blocks: Block[] = [];

  blocks.push({
    key: "outcome",
    lines: [s(`${glyph} ${report.outcome}`, color, "bold")],
  });

  // `setup-failed` is both the outcome and the assessment; saying it twice
  // reads like a stutter.
  const assessment: (string | null)[] = [
    report.assessment.kind === report.outcome
      ? `exit ${report.assessment.exitCode}`
      : `${s(report.assessment.kind, color)} · exit ${report.assessment.exitCode}`,
    ...wrap(report.assessment.reason, valueWidth),
  ];
  if (report.setupFailure !== null) {
    for (const line of report.setupFailure.split("\n")) {
      for (const wrapped of wrap(line, valueWidth)) {
        assessment.push(s(wrapped, "red"));
      }
    }
  }
  if (report.workload?.timedOut === true) {
    assessment.push(
      s(
        truncate(
          "workload hit the executor timeout and was killed — treat the outcome with suspicion",
          valueWidth,
        ),
        "yellow",
      ),
    );
  }
  for (const error of report.cleanupErrors) {
    for (const line of wrap(`cleanup error: ${error}`, valueWidth)) {
      assessment.push(s(line, "yellow"));
    }
  }
  blocks.push({ key: "assessment", lines: assessment });

  if (report.verdict !== null) {
    blocks.push({
      key: "verdict",
      lines: [truncate(report.verdict.reason, valueWidth)],
    });
  }

  // The differential is the reason a reproduction claim is credible, so it
  // is a first-class row rather than something to dig out of the JSON.
  const comparisons = report.comparisons ?? [];
  if (comparisons.length > 0) {
    const pad = Math.max(...comparisons.map((item) => item.name.length)) + 2;
    const lines: (string | null)[] = [];
    for (const item of comparisons) {
      const headline =
        item.status === "waived"
          ? "waived"
          : item.status === "ok"
            ? `${item.observed} (expected ${item.expected})`
            : item.status;
      const tone: ColorName | null = item.violated
        ? "red"
        : item.status === "ok"
          ? "green"
          : item.status === "waived"
            ? null
            : "yellow";
      const text =
        `${tint(item.name.padEnd(pad), KEY_RGB, { color: s.enabled, depth })}` +
        truncate(`${headline}  ${item.runner}`, valueWidth - pad);
      lines.push(tone === null ? text : s(text, tone));
      if (item.violated || item.status === "engine-missing") {
        for (const wrapped of wrap(item.detail, valueWidth - 2)) {
          lines.push(`  ${wrapped}`);
        }
      }
    }
    blocks.push({ key: "baseline", lines });
  }

  // A failure has to say what to do next: the lines that looked wrong, where
  // the full logs are, and the flag that shows everything.
  if (report.diagnosis.length > 0) {
    blocks.push({
      key: "diagnosis",
      lines: report.diagnosis.flatMap((line) =>
        wrap(line, valueWidth).map((wrapped) => s(wrapped, "yellow")),
      ),
    });
  }
  if (report.outcome === "setup-failed") {
    const runDir = latestRunDir(options.cwd);
    blocks.push({
      key: "next",
      lines: [
        "re-run with --verbose to see everything the chained tools printed",
        ...(runDir === null ? [] : [`full logs: ${runDir}/logs/`]),
      ],
    });
  }

  const componentNames = Object.keys(report.components);
  if (componentNames.length > 0) {
    const pad = Math.max(...componentNames.map((name) => name.length)) + 2;
    blocks.push({
      key: "components",
      lines: componentNames.map(
        (name) =>
          `${tint(name.padEnd(pad), KEY_RGB, { color: s.enabled, depth })}` +
          truncate(report.components[name], valueWidth - pad),
      ),
    });
  }

  if (report.evidence.length > 0) {
    const lines: (string | null)[] = [];
    report.evidence.forEach((item, index) => {
      if (index > 0) {
        lines.push(null);
      }
      const found = item.matches.length;
      const headline =
        found === 0
          ? "no matches"
          : `${found} match${found === 1 ? "" : "es"}, first at line ${item.matches[0].line}`;
      // Count before the pattern spec: on a narrow terminal the spec is what
      // you can afford to lose, not "did we capture anything".
      const summary = `${item.name}  ${headline}  ${item.stream} ~ /${item.pattern}/`;
      lines.push(
        summary.length > valueWidth
          ? truncate(summary, valueWidth)
          : `${tint(item.name, KEY_RGB, { color: s.enabled, depth })}` +
              `  ${headline}  ${item.stream} ~ /${item.pattern}/`,
      );
      if (item.note) {
        lines.push(`  ${truncate(item.note, valueWidth - 2)}`);
      }
      const context = (item.matches[0]?.context ?? [])
        .map((raw) => formatEvidenceLine(raw, item.pattern, valueWidth - 2, s))
        .filter((line): line is string => line !== null);
      if (context.length > 0) {
        // The captured excerpt is a quotation, not more prose: give it air.
        lines.push(null);
        lines.push(...context.map((line) => `  ${line}`));
      }
    });
    blocks.push({ key: "evidence", lines });
  }

  const pairOptions = { color: s.enabled, depth, width: valueWidth };
  blocks.push({
    key: "target",
    lines: [
      pairs(
        [
          ["env", report.target.env],
          ["mode", report.target.mode],
          ["lifecycle", report.scenario.lifecycle.state],
        ],
        pairOptions,
      ),
    ],
  });
  blocks.push({
    key: "timing",
    lines: [
      pairs(
        [
          ["total", formatSeconds(report.timing.seconds)],
          ...report.timing.phases.map((phase): [string, string] => [
            phase.name,
            formatSeconds(phase.seconds),
          ]),
        ],
        pairOptions,
      ),
    ],
  });
  // Never truncated: a cut path cannot be copied.
  blocks.push({
    key: "report",
    lines: [relativizePath(reportPath, options.cwd)],
  });

  const frame = (text: string): string =>
    tint(text, FRAME_RGB, { color: s.enabled, depth });
  const bar = frame("│");
  const rows: string[] = [];
  // Two weights of break: a dashed line divides one key from the next, a
  // bar-only row breaks within a key. Both keep the vertical rule unbroken.
  const gap = (): void => {
    rows.push(`  ${" ".repeat(gutter)} ${bar}`);
  };
  // Short stub past the junction that fades out: a clear boundary where it
  // meets the rule, nothing competing further out.
  const stub = Math.max(0, Math.min(15, width - gutter - 4));
  const divider = (): void => {
    rows.push(
      frame(`${"─".repeat(gutter + 3)}┼`) +
        fade("─", stub, { color: s.enabled, depth }),
    );
  };
  if (options.continued === true) {
    divider();
  } else {
    rows.push(
      `${s(report.scenario.id, "bold")}  ${truncate(
        report.scenario.title,
        width - report.scenario.id.length - 2,
      )}`,
    );
    rows.push(
      frame(
        `${"─".repeat(gutter + 3)}┬${"─".repeat(Math.max(0, width - gutter - 4))}`,
      ),
    );
  }
  blocks.forEach((block, index) => {
    // Multi-line values run into the next key otherwise; consecutive
    // single-line rows stay grouped so the footer does not sprawl.
    const previous = blocks[index - 1];
    if (
      previous !== undefined &&
      (previous.lines.length > 1 || block.lines.length > 1)
    ) {
      divider();
    }
    block.lines.forEach((line, position) => {
      if (line === null) {
        gap();
      } else if (position === 0) {
        rows.push(
          `  ${tint(block.key.padStart(gutter), KEY_RGB, { color: s.enabled, depth })} ${bar} ${line}`,
        );
      } else {
        rows.push(`  ${" ".repeat(gutter)} ${bar} ${line}`);
      }
    });
  });
  rows.push(
    frame(
      `${"─".repeat(gutter + 3)}┴${"─".repeat(Math.max(0, width - gutter - 4))}`,
    ),
  );
  return rows;
}

/** Drop the compose scaffolding, keep the message legible, and make the line
 * that actually matched stand out from its surrounding context. Returns null
 * for a line that carries nothing once the prefix is gone. */
function formatEvidenceLine(
  raw: string,
  pattern: string,
  width: number,
  s: Style,
): string | null {
  const message = stripAnsi(raw).replace(LOG_PREFIX_PATTERN, "");
  if (message.trim().length === 0) {
    return null;
  }
  let matched = false;
  try {
    matched = new RegExp(pattern).test(message);
  } catch {
    matched = false;
  }
  // Bold-against-plain is enough contrast to find the matched line; dimming
  // the context too would make the whole block recede.
  const text = truncate(message, width);
  return matched ? s(text, "bold") : text;
}

/** The run the platform retained for inspection, if one is on disk. */
function latestRunDir(cwd?: string): string | null {
  const runs = path.join(cwd ?? process.cwd(), ".local-platform", "runs");
  try {
    const newest = readdirSync(runs).sort().at(-1);
    return newest === undefined
      ? null
      : relativizePath(path.join(runs, newest), cwd);
  } catch {
    return null;
  }
}

function relativizePath(target: string, cwd?: string): string {
  const base = cwd ?? process.cwd();
  const relative = path.relative(base, target);
  return relative && !relative.startsWith("..") ? relative : target;
}

function terminalWidth(): number {
  return process.stdout.columns && process.stdout.columns > 0
    ? process.stdout.columns
    : 100;
}

export function formatSeconds(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds - minutes * 60)).padStart(2, "0")}s`;
}
