// `ass present`: put another program's output behind the ASS table.
//
// A dev loop chains programs ASS does not own - three frontend dev servers
// under `pnpm dev`, for instance - and each of them floods the terminal
// with its own startup format. The presenter already knows how to quote a
// chained program's lines and keep its noise behind `--verbose`; this verb
// exposes that to anything that can be piped, so a shell script can speak
// with the same voice as the rest of the tool.

import process from "node:process";
import readline from "node:readline";
import { Presenter } from "./presenter";

export interface PresentOptions {
  /** Opens the frame: `ASS <id>  <title>`. Omit for a bare block. */
  id?: string;
  title?: string;
  /** `key=first line\nsecond line...` - a phase and its rows. */
  blocks?: string[];
  /** Phase the streamed lines are quoted under, `name` or `name=detail`. */
  step?: string;
  /** Lines matching this are always shown, not just when notable. */
  highlight?: string;
  verbose?: boolean;
  color?: boolean;
  /** When the chained program says nothing worth showing, print this one
   * line instead of a whole frame. A warm `make local-dev` should not pay
   * three banners to report that nothing happened. */
  collapse?: string;
  io: { out(line: string): void; err(line: string): void };
  /** Defaults to `process.stdin`; a TTY (nothing piped) renders the blocks
   * and returns immediately. */
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  animate?: { write(text: string): unknown };
}

export async function runPresent(options: PresentOptions): Promise<number> {
  // The frame is written into a gate: nothing reaches the terminal until
  // the chained program produces a line worth showing. Then everything
  // buffered flushes at once and the rest streams live - so a slow boot is
  // still watchable, and a quiet one costs a single line.
  const gate = new OutputGate(options.io, options.collapse === undefined);
  const presenter = new Presenter({
    io: gate.io,
    color: options.color,
    verbose: options.verbose,
    animate: gate.open ? options.animate : undefined,
  });
  presenter.banner(options.id ?? "ass", options.title ?? "");

  for (const block of options.blocks ?? []) {
    const separator = block.indexOf("=");
    const [key, body] =
      separator === -1
        ? [block, ""]
        : [block.slice(0, separator), block.slice(separator + 1)];
    const [first, ...rest] = body.split("\n");
    presenter.step(key, first ?? "");
    for (const line of rest) {
      presenter.note(line);
    }
  }
  // Blocks are content the caller asked for, so they open the gate.
  if ((options.blocks ?? []).length > 0) {
    gate.release();
  }

  const input = options.input ?? process.stdin;
  if (input.isTTY === true) {
    presenter.close();
    gate.finish(options.collapse);
    return 0;
  }

  if (options.step !== undefined) {
    const separator = options.step.indexOf("=");
    // The detail is the caller's to write: this verb has no opinion about
    // what the piped program is doing.
    presenter.step(
      separator === -1 ? options.step : options.step.slice(0, separator),
      separator === -1 ? "" : options.step.slice(separator + 1),
    );
  }
  const highlight =
    options.highlight === undefined ? null : new RegExp(options.highlight, "i");

  // Closing the frame exactly once, whether the child ends, the pipe breaks
  // or the user interrupts: an unclosed table is a visible defect.
  let closed = false;
  const close = (): void => {
    if (!closed) {
      closed = true;
      presenter.close();
      gate.finish(options.collapse);
    }
  };
  const onSignal = (): void => {
    close();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const before = gate.writes;
    if (highlight !== null && highlight.test(line)) {
      presenter.note(line.trim());
    } else {
      presenter.child(line);
    }
    // A line that survived the presenter's filter is the signal that this
    // run has something to say.
    if (gate.writes > before) {
      gate.release();
    }
  }
  close();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  return 0;
}

/** Holds output back until there is something worth a frame. */
class OutputGate {
  private readonly buffer: string[] = [];
  private released: boolean;
  /** Counts lines the presenter produced, so the caller can tell whether a
   * child line survived the quiet filter. */
  writes = 0;
  readonly io: { out(line: string): void; err(line: string): void };

  constructor(
    private readonly sink: { out(line: string): void; err(line: string): void },
    releasedAtStart: boolean,
  ) {
    this.released = releasedAtStart;
    this.io = {
      out: (line) => this.write(line),
      err: (line) => this.sink.err(line),
    };
  }

  get open(): boolean {
    return this.released;
  }

  private write(line: string): void {
    this.writes += 1;
    if (this.released) {
      this.sink.out(line);
      return;
    }
    this.buffer.push(line);
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    for (const line of this.buffer) {
      this.sink.out(line);
    }
    this.buffer.length = 0;
  }

  /** Nothing surfaced: drop the frame and say the one line instead. */
  finish(collapse: string | undefined): void {
    if (this.released) {
      return;
    }
    this.buffer.length = 0;
    if (collapse !== undefined && collapse !== "") {
      this.sink.out(collapse);
    }
    this.released = true;
  }
}
