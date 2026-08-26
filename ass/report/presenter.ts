// One voice for the whole run. A repro chains several programs — the
// local-platform Python CLI, docker compose, Jest — and each of them wants to
// write to the terminal in its own format. The presenter owns the terminal
// instead: it opens the same table the summary closes, renders phases as keys
// and everything those programs say as continuation rows, and keeps their
// noise behind `--verbose` unless it looks like something went wrong.

import process from "node:process";
import {
  colorDepth,
  colorEnabled,
  fade,
  GUTTER,
  makeStyle,
  stripAnsi,
  pairs,
  tint,
  truncate,
  wrap,
  FRAME_RGB,
  KEY_RGB,
  type ColorDepth,
  type ColorName,
  type Style,
} from "./style";

export interface PresenterIo {
  out(line: string): void;
  err(line: string): void;
}

/** Where the live progress indicator draws. Only ever a real TTY (the CLI
 * checks `isTTY` before passing one): the transient row repaints itself with
 * carriage returns, which in a pipe or CI log would be garbage. */
export interface SpinnerSink {
  write(text: string): unknown;
}

export interface PresenterOptions {
  io: PresenterIo;
  color?: boolean;
  depth?: ColorDepth;
  width?: number;
  /** Pass subprocess output through verbatim instead of filtering it. */
  verbose?: boolean;
  /** TTY to animate the progress row on; omit for pipes/CI/tests. */
  animate?: SpinnerSink;
  /** Test seam for the spinner clock. */
  now?: () => number;
}

/** How often the wave rolls one glyph. Slow enough to be calm, fast enough
 * that a stall is visibly a stall. */
const SPINNER_INTERVAL_MS = 160;

/** Whole seconds only: a ticking decimal reads as flicker, not progress. */
function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes}m${total % 60}s` : `${total}s`;
}

const CLEAR_LINE = "\r\x1b[2K";

/** Lines from a child process worth surfacing even when quiet: anything that
 * reads like a failure, plus the local-platform step markers. */
const NOTABLE =
  /\b(error|errors|warning|failed|failure|fatal|panic|denied|refused|timed out|cannot|unable)\b/i;

/** Pure noise even in verbose runs: compose's per-container progress spam and
 * the blank frames its TTY renderer emits. */
const NOISE = /^(\s*$|\[\+\]|\s*[✔✘⠿]\s|Container\s|Volume\s|Network\s)/;

/** `HH:MM:SS LEVEL message` from the local-platform logger, or its
 * `[local-platform] message` prefix — we re-render the message ourselves. */
const PLATFORM_PREFIX =
  /^(?:\d{2}:\d{2}:\d{2}\s+)?(?:(WARNING|ERROR|INFO)\s+)?(?:\[local-platform\]\s*)?/;

/** Marks the start of ASS's output: a wave of arches rising, levelling and
 * dipping, deliberately a different texture from the table's solid `─` so it
 * reads as "a new program is speaking" rather than more frame. The shape is
 * also a nod to the tool's name, which we will not be elaborating on. */
const START_CYCLE = ["⁀", "⁀", "·", "~", "·"] as const;

/** A wave exactly `width` wide — every position carries a glyph, so it can
 * neither overrun the terminal nor leave trailing whitespace. */
function startRule(width: number): string {
  let rule = "";
  for (let column = 0; column < width; column++) {
    rule += START_CYCLE[column % START_CYCLE.length];
  }
  return rule;
}

export class Presenter {
  private readonly io: PresenterIo;
  private readonly s: Style;
  private readonly depth: ColorDepth;
  private readonly width: number;
  private readonly verbose: boolean;
  private open = false;
  /** No divider between the banner and the first phase: the frame's own top
   * rule is already there, and two stacked rules read as a mistake. */
  private freshFrame = false;
  /** Notable child lines, kept so a failure can restate them after the
   * scrollback has buried them. */
  private readonly notable: string[] = [];
  /** Set when the previous child line was notable, so its evidence line
   * survives the quiet filter too. */
  private contextFollows = false;
  private readonly animate: SpinnerSink | null;
  private readonly now: () => number;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private spinnerFrame = 0;
  private phaseStartedMs: number;
  /** True while the transient progress row is on screen and must be erased
   * before any real line prints under it. */
  private transientShown = false;
  private spinnerStopped = false;

  constructor(options: PresenterOptions) {
    this.io = options.io;
    this.s = makeStyle(options.color ?? colorEnabled());
    this.depth = options.depth ?? colorDepth();
    this.width = Math.max(40, Math.min(options.width ?? terminalWidth(), 120));
    this.verbose = options.verbose ?? false;
    this.animate = options.animate ?? null;
    this.now = options.now ?? Date.now;
    this.phaseStartedMs = this.now();
  }

  /** The color decision this presenter resolved. The closing summary is
   * rendered separately but shares the frame, so it must share this too. */
  get color(): boolean {
    return this.s.enabled;
  }

  /** Every real line erases the transient progress row first, so the wave
   * always sits at the live bottom edge of the table. */
  private out(line: string): void {
    this.clearTransient();
    this.io.out(line);
  }

  /** One roll of the wave plus the current phase's elapsed time. Runs on the
   * spinner timer; public so tests can drive it without one. */
  tick(): void {
    if (this.animate === null || this.spinnerStopped) {
      return;
    }
    const cycle = START_CYCLE.length;
    let wave = "";
    for (let column = 0; column < 5; column++) {
      wave +=
        START_CYCLE[(((column - this.spinnerFrame) % cycle) + cycle) % cycle];
    }
    this.spinnerFrame++;
    const row =
      `  ${" ".repeat(GUTTER)} ${this.frame("│")} ${this.frame(wave)} ` +
      elapsedLabel(this.now() - this.phaseStartedMs);
    this.animate.write(`${CLEAR_LINE}${row}`);
    this.transientShown = true;
  }

  private clearTransient(): void {
    if (this.transientShown && this.animate !== null) {
      this.animate.write(CLEAR_LINE);
      this.transientShown = false;
    }
  }

  private stopSpinner(): void {
    this.clearTransient();
    this.spinnerStopped = true;
    if (this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  /** The frame's exact blue, independent of the terminal's palette. */
  private frame(text: string): string {
    return tint(text, FRAME_RGB, { color: this.s.enabled, depth: this.depth });
  }

  get valueWidth(): number {
    return this.width - GUTTER - 5;
  }

  /** Opens the table the summary later closes. The start rule and `ASS` label
   * mark where our output begins: `pnpm run` prints its own two-line preamble
   * before we get control, and only `pnpm -s ass` or `./bin/ass` avoid it. */
  banner(id: string, title: string): void {
    const label = this.s(this.frame("ASS"), "bold");
    this.out(this.frame(startRule(this.width)));
    this.out(
      `${label}  ${this.s(id, "bold")}  ` +
        truncate(title, this.width - id.length - 7),
    );
    this.out(
      this.frame(
        `${"─".repeat(GUTTER + 3)}┬${"─".repeat(Math.max(0, this.width - GUTTER - 4))}`,
      ),
    );
    this.open = true;
    this.freshFrame = true;
    if (this.animate !== null && this.spinnerTimer === null) {
      this.spinnerTimer = setInterval(() => this.tick(), SPINNER_INTERVAL_MS);
      // Never hold the process open: the timer is decoration, not work.
      this.spinnerTimer.unref?.();
    }
  }

  /** A new phase: divider, then the phase name in the key column. */
  step(
    name: string,
    detail: string | Array<[string, string]> = "",
    tone?: ColorName,
  ): void {
    if (this.open && !this.freshFrame) {
      this.out(
        this.frame(`${"─".repeat(GUTTER + 3)}┼`) +
          fade("─", Math.max(0, Math.min(15, this.width - GUTTER - 4)), {
            color: this.s.enabled,
            depth: this.depth,
          }),
      );
    }
    this.open = true;
    this.freshFrame = false;
    // The wave's clock reads per-phase: "how long has *this* step been
    // going" is the question a watcher is actually asking.
    this.phaseStartedMs = this.now();
    this.spinnerFrame = 0;
    const plain =
      typeof detail === "string"
        ? truncate(detail, this.valueWidth)
        : pairs(detail, {
            color: this.s.enabled,
            depth: this.depth,
            width: this.valueWidth,
          });
    // A phase whose first line is its message should carry it on the key row,
    // not leave the key stranded above an empty value.
    const text = tone === undefined ? plain : this.s(plain, tone);
    const key = tint(name.padStart(GUTTER), KEY_RGB, {
      color: this.s.enabled,
      depth: this.depth,
    });
    const bar = this.frame("│");
    // No trailing whitespace when a phase has nothing to add to its name.
    this.out(text.length > 0 ? `  ${key} ${bar} ${text}` : `  ${key} ${bar}`);
  }

  /** Something ASS itself has to say, under the current phase. */
  note(text: string): void {
    for (const line of wrap(text, this.valueWidth)) {
      this.row(line);
    }
  }

  warn(text: string): void {
    for (const line of wrap(text, this.valueWidth)) {
      this.row(this.s(line, "yellow"));
    }
  }

  error(text: string): void {
    for (const line of wrap(text, this.valueWidth)) {
      this.row(this.s(line, "red"));
    }
  }

  /** A line from a chained program. Indented a step further so it reads as
   * quoted rather than spoken by ASS, and dropped when it is noise. */
  child(raw: string): void {
    const text = stripAnsi(raw).replace(/\s+$/, "");
    if (NOISE.test(text)) {
      return;
    }
    // The tool states its own severity in the prefix. Judge notability from
    // that *before* stripping it — testing the remaining prose instead threw
    // away lines like "Port 15432 … is already allocated", whose wording
    // matches no keyword but whose level was ERROR.
    const level = PLATFORM_PREFIX.exec(text)?.[1];
    const message = text.replace(PLATFORM_PREFIX, "").trim();
    if (message.length === 0) {
      return;
    }
    const notable =
      level === "ERROR" || level === "WARNING" || NOTABLE.test(message);
    // A notable line's successor is usually its evidence (the process holding
    // the port, the offending argument), so it rides along.
    const carry = this.contextFollows;
    this.contextFollows = notable;
    if (!this.verbose && !notable && !carry) {
      return;
    }
    if (notable) {
      this.notable.push(message);
    }
    const tone = level === "ERROR" ? "red" : notable ? "yellow" : undefined;
    // A prefix-free line that fits keeps the child's own colors and
    // indentation (a table's alignment is part of what it says). Lines that
    // must wrap fall back to the stripped text: ANSI breaks the width math.
    const rawLine = raw.replace(/\s+$/, "");
    const unprefixed = text.replace(PLATFORM_PREFIX, "") === text;
    if (
      tone === undefined &&
      unprefixed &&
      text.length <= this.valueWidth - 2
    ) {
      this.row(`  ${this.s.enabled ? rawLine : text}`);
      return;
    }
    for (const line of wrap(message, this.valueWidth - 2)) {
      this.row(`  ${tone === undefined ? line : this.s(line, tone)}`);
    }
  }

  /** What the chained tools said that looked like trouble, most recent last. */
  diagnosis(limit = 5): string[] {
    return this.notable.slice(-limit);
  }

  /** Close the table when a run ends without a summary — an error after the
   * banner still has to leave the frame shut. */
  close(): void {
    this.stopSpinner();
    if (!this.open) {
      return;
    }
    this.out(
      this.frame(
        `${"─".repeat(GUTTER + 3)}┴${"─".repeat(Math.max(0, this.width - GUTTER - 4))}`,
      ),
    );
    this.open = false;
  }

  /** The summary's own rows, already formatted, continuing the same table. */
  summary(lines: string[]): void {
    this.stopSpinner();
    for (const line of lines) {
      this.out(line);
    }
    this.open = false;
  }

  private row(value: string): void {
    this.out(`  ${" ".repeat(GUTTER)} ${this.frame("│")} ${value}`);
  }
}

function terminalWidth(): number {
  if (process.stdout.columns && process.stdout.columns > 0) {
    return process.stdout.columns;
  }
  // Piped: a quoting parent (the local platform) forwards the real width.
  const forwarded = Number(process.env["COLUMNS"]);
  return Number.isFinite(forwarded) && forwarded > 0 ? forwarded : 100;
}
