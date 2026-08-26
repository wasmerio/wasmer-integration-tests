// The presenter is the contract that a run reads as one program's output:
// where ass's own output starts, what the chained tools are allowed to say,
// and that every line hangs off the same table.

import { Presenter } from "../../ass/report/presenter";
import { stripAnsi } from "../../ass/report/style";

function capture(verbose = false): {
  presenter: Presenter;
  lines: () => string[];
} {
  const out: string[] = [];
  const presenter = new Presenter({
    io: { out: (line) => out.push(line), err: (line) => out.push(line) },
    color: false,
    width: 80,
    verbose,
  });
  return { presenter, lines: () => out.map(stripAnsi) };
}

describe("presenter", () => {
  test("marks where ass output starts, since pnpm prints its own preamble", () => {
    const { presenter, lines } = capture();
    presenter.banner("WAX-600", "Edge wasix cross-Store panic");
    // A scalloped rule — a different texture from the table's own `─` —
    // separates us from whatever the shell wrapper printed, and the label
    // names the program taking over.
    expect(lines()[0]).toMatch(/^(?:⁀⁀·~·)+$/);
    // Every column carries a glyph: it can neither wrap nor trail a space.
    expect(lines()[0]).toHaveLength(80);
    expect(lines()[0]).toBe(lines()[0].trimEnd());
    expect(lines()[1]).toMatch(/^ASS {2}WAX-600 {2}Edge wasix/);
    expect(lines()[2]).toMatch(/^─+┬─+$/);
  });

  test("phases are keys on the same table as the summary", () => {
    const { presenter, lines } = capture();
    presenter.banner("WAX-600", "t");
    presenter.step("setup");
    presenter.note("wiped cache .local-platform/cache/edge/compiler_cache");
    const rendered = lines();
    // A phase with no detail leaves no trailing whitespace.
    expect(rendered).toContain("       setup │");
    expect(rendered).toContain(
      "             │ wiped cache .local-platform/cache/edge/compiler_cache",
    );
  });

  test("chained-tool noise is filtered unless it looks like trouble", () => {
    const { presenter, lines } = capture();
    presenter.banner("X", "t");
    presenter.step("setup");
    presenter.child("[local-platform] Dependency services complete");
    presenter.child("[+] Running 12/12");
    presenter.child(" ✔ Container wit-edge-1  Removed  12.5s");
    presenter.child("09:27:27 WARNING Backend image pull failed");
    const rendered = lines().join("\n");
    // Routine chatter and compose spam stay out of the way…
    expect(rendered).not.toContain("Dependency services complete");
    expect(rendered).not.toContain("Running 12/12");
    expect(rendered).not.toContain("Removed");
    // …but anything that reads like a failure survives, with the tool's own
    // timestamp/level prefix re-rendered as ours.
    expect(rendered).toContain("Backend image pull failed");
    expect(rendered).not.toContain("09:27:27");
    expect(rendered).not.toContain("WARNING");
  });

  test("a tool's own ERROR level counts, whatever the wording", () => {
    const { presenter, lines } = capture();
    presenter.banner("X", "t");
    presenter.step("setup");
    // Real regression: this line matches none of the failure keywords, and
    // dropping it left a run failing with no stated reason.
    presenter.child(
      "09:30:20 WARNING Port 15432 for Postgres is already in use:",
    );
    presenter.child(
      "d9c30af00cc5 wit-postgres-1 0.0.0.0:15432->5432/tcp, [::]:15432->5432/tcp",
    );
    presenter.child(
      "09:30:20 ERROR   Port 15432 for Postgres is already allocated. Stop the process using it.",
    );
    const rendered = lines().join("\n");
    expect(rendered).toContain("is already allocated");
    // The line after a notable one is its evidence, so it rides along.
    expect(rendered).toContain("0.0.0.0:15432->5432/tcp");
    // And it is retained for the failure summary.
    expect(presenter.diagnosis().join("\n")).toContain("already allocated");
  });

  test("verbose passes the chatter through", () => {
    const { presenter, lines } = capture(true);
    presenter.banner("X", "t");
    presenter.step("setup");
    presenter.child("[local-platform] Dependency services complete");
    expect(lines().join("\n")).toContain("Dependency services complete");
  });
});

describe("the progress wave", () => {
  function captureAnimated(): {
    presenter: Presenter;
    lines: () => string[];
    frames: () => string[];
    advance: (ms: number) => void;
  } {
    const out: string[] = [];
    const writes: string[] = [];
    let clock = 100_000;
    const presenter = new Presenter({
      io: { out: (line) => out.push(line), err: (line) => out.push(line) },
      color: false,
      width: 80,
      animate: { write: (text: string) => writes.push(text) },
      now: () => clock,
    });
    return {
      presenter,
      lines: () => out.map(stripAnsi),
      frames: () => writes,
      advance: (ms) => {
        clock += ms;
      },
    };
  }

  test("renders the wave with the current phase's elapsed time", () => {
    const { presenter, frames, advance } = captureAnimated();
    presenter.banner("X", "t");
    presenter.step("workload");
    advance(83_000);
    presenter.tick();
    const frame = stripAnsi(frames()[frames().length - 1]);
    expect(frame).toContain("1m23s");
    expect(frame).toMatch(/[⁀·~]{5}/); // the banner's own texture, rolling
    // Repaint-in-place: every frame starts by erasing the previous one.
    expect(frames()[frames().length - 1].startsWith("\r\x1b[2K")).toBe(true);
  });

  test("the wave rolls and the clock resets per phase", () => {
    const { presenter, frames, advance } = captureAnimated();
    presenter.banner("X", "t");
    presenter.step("setup");
    advance(5_000);
    presenter.tick();
    presenter.tick();
    const [a, b] = frames().slice(-2).map(stripAnsi);
    expect(a).not.toBe(b); // the animation animates
    expect(b).toContain("5s");
    presenter.step("workload"); // new phase, new clock
    presenter.tick();
    expect(stripAnsi(frames()[frames().length - 1])).toContain("│ ");
    expect(stripAnsi(frames()[frames().length - 1])).toContain(" 0s");
  });

  test("real output erases the transient row first and stays clean", () => {
    const { presenter, lines, frames } = captureAnimated();
    presenter.banner("X", "t");
    presenter.step("setup");
    presenter.tick();
    const before = frames().length;
    presenter.note("resolving fixtures");
    // The erase went to the TTY sink, the content to the ordinary io.
    expect(frames()[before]).toBe("\r\x1b[2K");
    expect(lines().join("\n")).toContain("resolving fixtures");
    expect(lines().join("\n")).not.toContain("\r");
  });

  test("the summary stops the wave for good", () => {
    const { presenter, frames } = captureAnimated();
    presenter.banner("X", "t");
    presenter.step("setup");
    presenter.tick();
    presenter.summary(["done"]);
    const settled = frames().length;
    presenter.tick(); // a straggling timer fire after the run ended
    expect(frames().length).toBe(settled);
  });

  test("without a TTY sink nothing ever animates", () => {
    const { presenter, lines } = capture();
    presenter.banner("X", "t");
    presenter.step("setup");
    presenter.tick();
    presenter.note("quiet");
    expect(lines().join("\n")).not.toContain("\r");
  });
});
