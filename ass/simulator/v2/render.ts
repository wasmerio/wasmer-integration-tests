// How a reconcile is presented. It is not a new format: it is ASS's own
// table (`report/presenter.ts`) - the start rule, the `ass` banner, the
// gutter key column, the frame bar, the fading phase dividers - with the
// reconcile's phases as steps. `ass up` should look like `ass run`, because
// it is the same tool speaking.
//
// What is reconcile-specific is only the *content* of the rows:
//   - one row per (verb, kind) in dependency order, never alphabetical;
//   - counts right-aligned in a fixed column, so magnitudes compare;
//   - durations in the unit that carries information (42ms, 3.5s, 1m14s).

import process from "node:process";
import { Presenter } from "../../report/presenter";
import { formatBlocks, type Block } from "../../report/report";
import {
  colorDepth,
  KEY_RGB,
  makeStyle,
  tint,
  type ColorDepth,
} from "../../report/style";
import { kindIndex, type ResourceKind } from "./model";
import type { Plan } from "./plan";

const VERB_ORDER = [
  "create",
  "update",
  "patch",
  "promote",
  "demote",
  "replace",
  "delete",
];

export function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** The unit that carries information: sub-second work is milliseconds, a
 * long apply is minutes and seconds. Eight rows of `0.0s` say nothing. */
export function duration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** Plural that reads as English: "1 app", "12 apps", "1 request-bucket". */
export function plural(kind: string, value: number): string {
  return value === 1 ? kind : `${kind}s`;
}

export interface PlanRow {
  verb: string;
  kind: ResourceKind;
  count: number;
}

/** Rows in dependency order (KIND_ORDER), verbs in escalation order within
 * a kind. The reader wants "what happens, in what order", not a dictionary
 * - alphabetical put `namespace` after `invoices`. */
export function planRows(plan: Plan): PlanRow[] {
  const rows: PlanRow[] = [];
  for (const [kind, verbs] of Object.entries(plan.counts)) {
    for (const verb of VERB_ORDER) {
      const value = verbs[verb];
      if (value !== undefined && value > 0) {
        rows.push({ verb, kind: kind as ResourceKind, count: value });
      }
    }
  }
  return rows.sort(
    (a, b) =>
      kindIndex(a.kind) - kindIndex(b.kind) ||
      VERB_ORDER.indexOf(a.verb) - VERB_ORDER.indexOf(b.verb),
  );
}

export interface Columns {
  label: number;
  count: number;
}

/** One set of widths for the whole run, so the apply rows line up under the
 * plan rows they correspond to. */
export function columnsFor(rows: PlanRow[]): Columns {
  // The apply rows reuse this width with their own verbs ("wrote",
  // "removed"), so the column is sized for whichever is longest - otherwise
  // a `delete` plan lines up and its `removed` rows do not.
  const applyVerb = Math.max(
    ..."wrote removed".split(" ").map((verb) => verb.length),
  );
  return {
    label: Math.max(
      0,
      ...rows.map(
        (row) =>
          Math.max(row.verb.length, applyVerb) +
          1 +
          plural(row.kind, row.count).length,
      ),
    ),
    count: Math.max(0, ...rows.map((row) => count(row.count).length)),
  };
}

export interface ReporterOptions {
  io: { out(line: string): void; err(line: string): void };
  color?: boolean;
  depth?: ColorDepth;
  verbose?: boolean;
  /** TTY to animate the progress wave on; omit for pipes and CI. */
  animate?: { write(text: string): unknown };
}

/** The reconciler's voice: every phase is an ASS step, every row an ASS
 * row, the frame opened once and closed once. */
export class ReconcileReporter {
  private readonly presenter: Presenter;
  private readonly color: boolean;
  private readonly depth: ColorDepth | undefined;
  private columns: Columns = { label: 0, count: 0 };
  private opened = false;
  private readonly width: number;

  constructor(options: ReporterOptions) {
    this.presenter = new Presenter({
      io: options.io,
      color: options.color,
      depth: options.depth,
      verbose: options.verbose,
      animate: options.animate,
    });
    this.color = this.presenter.color;
    this.depth = options.depth;
    this.width = Math.max(40, Math.min(process.stdout.columns || 100, 120));
  }

  banner(slug: string, title: string): void {
    this.presenter.banner(slug, title);
    this.opened = true;
  }

  /** A row whose label is a tinted key and whose count is right-aligned -
   * the same key/value contrast `pairs()` gives a step's detail line. */
  private row(label: string, value: string, trailing = ""): void {
    const key = tint(label.padEnd(this.columns.label), KEY_RGB, {
      color: this.color,
      depth: this.depth,
    });
    this.presenter.note(
      `${key}  ${value.padStart(this.columns.count)}${trailing}`,
    );
  }

  plan(plan: Plan): void {
    const rows = planRows(plan);
    this.columns = columnsFor(rows);
    if (rows.length === 0) {
      this.presenter.step("plan", [
        ["converged", `${count(plan.keeps)} resources match`],
        ...(plan.surplus.length > 0
          ? ([
              [
                "surplus",
                `${count(plan.surplus.length)} ${plural("bucket", plan.surplus.length)}`,
              ],
            ] as Array<[string, string]>)
          : []),
      ]);
      return;
    }
    const totals = new Map<string, number>();
    for (const row of rows) {
      totals.set(row.verb, (totals.get(row.verb) ?? 0) + row.count);
    }
    this.presenter.step(
      "plan",
      VERB_ORDER.filter((verb) => totals.has(verb))
        .map(
          (verb) =>
            [verb, count(totals.get(verb) as number)] as [string, string],
        )
        .concat(plan.keeps > 0 ? [["keep", count(plan.keeps)]] : []),
    );
    for (const row of rows) {
      this.row(`${row.verb} ${plural(row.kind, row.count)}`, count(row.count));
    }
    if (plan.surplus.length > 0) {
      const worst = [...plan.surplus].sort(
        (a, b) => b.observed - b.desired - (a.observed - a.desired),
      )[0];
      this.presenter.note(
        `surplus: ${count(plan.surplus.length)} ${plural("bucket", plan.surplus.length)} ` +
          `${plan.surplus.length === 1 ? "holds" : "hold"} more than declared ` +
          `(largest +${count(worst.observed - worst.desired)}) - reported, not written`,
      );
    }
  }

  apply(workers: {
    global: number;
    sdk: number;
    clickhouse: number;
    postgres: number;
  }): void {
    this.presenter.step("apply", [
      ["workers", String(workers.global)],
      ["sdk", String(workers.sdk)],
      ["clickhouse", String(workers.clickhouse)],
      ["postgres", String(workers.postgres)],
    ]);
  }

  applied(event: {
    kind: ResourceKind;
    ops: number;
    ms: number;
    failed: boolean;
    verbs?: string[];
  }): void {
    if (event.failed) {
      this.presenter.error(
        `failed ${plural(event.kind, event.ops)}  ${count(event.ops)}`,
      );
      return;
    }
    // A batch that only removed things did not "write" them.
    const verb =
      event.verbs !== undefined &&
      event.verbs.length > 0 &&
      event.verbs.every((type) => type === "delete")
        ? "removed"
        : "wrote";
    this.row(
      `${verb} ${plural(event.kind, event.ops)}`,
      count(event.ops),
      `  ${duration(event.ms)}`,
    );
  }

  /** The closing block, in the shape `ass run` ends with: an outcome row
   * carrying a glyph and a tone, then the facts a human needs next - where
   * to sign in and what the world holds. */
  summary(input: {
    slug: string;
    outcome: "reconciled" | "converged" | "released" | "drifted" | "failed";
    operations: number;
    totalMs: number;
    observeMs: number;
    diffMs?: number;
    drilled?: number;
    signIn?: {
      dashboard: string;
      username: string;
      password: string;
      namespace: string;
    };
    errors?: string[];
  }): void {
    const style = makeStyle(this.color);
    const glyphs = {
      reconciled: { glyph: "✔", color: "green" as const },
      converged: { glyph: "●", color: "cyan" as const },
      released: { glyph: "✔", color: "green" as const },
      drifted: { glyph: "▲", color: "yellow" as const },
      failed: { glyph: "✖", color: "red" as const },
    }[input.outcome];

    const facts = [
      input.operations > 0
        ? `${count(input.operations)} operations`
        : "no changes",
      `took ${duration(input.totalMs)}`,
      `observed ${duration(input.observeMs)}`,
      ...(input.diffMs === undefined
        ? []
        : [`diffed ${duration(input.diffMs)}`]),
      ...(input.drilled === undefined
        ? []
        : [
            `${count(input.drilled)} ${plural("day group", input.drilled)} drilled`,
          ]),
    ].join(" · ");

    const blocks: Block[] = [
      {
        key: "outcome",
        lines: [
          style(`${glyphs.glyph} ${input.outcome}`, glyphs.color, "bold"),
          style(facts, "dim"),
        ],
      },
      { key: "scenario", lines: [input.slug] },
    ];
    for (const error of input.errors ?? []) {
      blocks.push({ key: "error", lines: [style(error, "red")] });
    }
    if (input.signIn !== undefined) {
      blocks.push(
        { key: "sign in", lines: [`${input.signIn.dashboard}/signin`] },
        {
          key: "account",
          lines: [`${input.signIn.username} / ${input.signIn.password}`],
        },
        {
          key: "workspace",
          lines: [`${input.signIn.dashboard}/${input.signIn.namespace}`],
        },
      );
    }
    this.presenter.summary(
      formatBlocks(blocks, {
        color: this.color,
        depth: this.depth ?? colorDepth(),
        width: this.width,
        continued: true,
      }),
    );
    this.opened = false;
  }

  step(name: string, detail: Array<[string, string]> | string = ""): void {
    this.presenter.step(name, detail);
  }

  note(text: string): void {
    this.presenter.note(text);
  }

  /** A line from a chained program (the platform driver, docker compose).
   * The presenter quotes it under the current phase and keeps its noise
   * behind `--verbose` - the same treatment `ass run` gives it. */
  child(line: string): void {
    this.presenter.child(line);
  }

  warn(text: string): void {
    this.presenter.warn(text);
  }

  error(text: string): void {
    this.presenter.error(text);
  }

  close(): void {
    if (this.opened) {
      this.presenter.close();
      this.opened = false;
    }
  }
}

/** The animation sink, on a real terminal only: the wave repaints with
 * carriage returns, which in a pipe or CI log is garbage. */
export function animationSink(): { write(text: string): unknown } | undefined {
  return process.stdout.isTTY === true ? process.stdout : undefined;
}
