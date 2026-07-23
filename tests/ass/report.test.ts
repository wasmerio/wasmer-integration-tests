// Summary-rendering tests: the run summary is the primary human output of a
// repro run, so its structure, its color gating, and its handling of hostile
// log content (container ANSI, compose prefixes, over-long lines) are
// behavior, not decoration.

import {
  formatSeconds,
  formatSummary,
  type RunReport,
} from "../../ass/report/report";
import {
  colorEnabled,
  fade,
  stripAnsi,
  colorDepth,
  rgbTo256,
  tint,
  truncate,
  FRAME_RGB,
  KEY_RGB,
} from "../../ass/report/style";

const ESC = "\u001b";

function makeReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    scenario: {
      id: "WAX-600",
      title: "Edge wasix cross-Store panic",
      slug: "wax-600",
      lifecycle: { state: "open" },
    },
    target: { env: "local", mode: "pinned" },
    selectors: { edge: "github-release:wasmerio/edge:v1:edge" },
    components: { edge: "edge-bin@fcdd9c4" },
    executor: { name: "jest", profile: {} },
    outcome: "reproduced",
    assessment: {
      kind: "expected",
      exitCode: 0,
      alerting: false,
      reason: "repro intact on the pinned versions",
    },
    verdict: {
      reproducedMatched: true,
      probe: null,
      notReproducedMatched: null,
      matchedPredicates: ["verdict.reproduced_when.any[0]"],
      unavailableStreams: [],
      reason: "matched verdict.reproduced_when.any[0]",
    },
    evidence: [],
    workload: null,
    timing: {
      startedAt: "2026-08-06T06:12:07.000Z",
      finishedAt: "2026-08-06T06:18:40.000Z",
      seconds: 393,
      phases: [
        {
          name: "setup",
          startedAt: "",
          finishedAt: "",
          seconds: 174,
        },
      ],
    },
    setupFailure: null,
    diagnosis: [],
    cleanupErrors: [],
    ...overrides,
  };
}

const render = (report: RunReport, color = false): string =>
  formatSummary(report, "/repo/.local-platform/run/ass/report.json", {
    color,
    width: 80,
    cwd: "/repo",
  }).join("\n");

describe("run summary", () => {
  test("leads with outcome, assessment, and exit code", () => {
    const text = render(makeReport());
    expect(text).toContain("✔ reproduced");
    expect(text).toContain("expected");
    expect(text).toContain("exit 0");
    expect(text).toContain("repro intact on the pinned versions");
    // Report paths under the working directory print relative.
    expect(text).toMatch(/report │ \.local-platform\/run\/ass\/report\.json/);
    // Keys are right-aligned against one vertical rule across every section,
    // and continuation rows keep the rule unbroken.
    expect(text).toMatch(/^ {5}outcome │ /m);
    expect(text).toMatch(/^ {2}assessment │ /m);
    expect(text).toMatch(/^ {12} │ repro intact/m);
  });

  test("emits no escape sequences unless color is enabled", () => {
    const plain = render(makeReport());
    expect(plain).not.toContain(ESC);
    const colored = render(makeReport(), true);
    expect(colored).toContain(ESC);
    // Same information either way.
    expect(stripAnsi(colored)).toEqual(plain);
  });

  test("each assessment gets a distinct glyph and color", () => {
    const alert = render(
      makeReport({
        outcome: "not-reproduced",
        assessment: {
          kind: "alert",
          exitCode: 2,
          alerting: true,
          reason: "repro rot: pinned versions no longer reproduce",
        },
      }),
      true,
    );
    expect(alert).toContain("✖ not-reproduced");
    expect(alert).toContain(`${ESC}[31m`); // red
    expect(alert).toContain("repro rot");

    const inconclusive = render(
      makeReport({
        outcome: "inconclusive",
        assessment: {
          kind: "inconclusive",
          exitCode: 3,
          alerting: false,
          reason: "the workload ran but matched no expectation",
        },
      }),
      true,
    );
    expect(inconclusive).toContain("▲ inconclusive");
    expect(inconclusive).toContain(`${ESC}[33m`); // yellow
  });

  test("outcome and assessment are not repeated when identical", () => {
    const text = render(
      makeReport({
        outcome: "setup-failed",
        assessment: {
          kind: "setup-failed",
          exitCode: 4,
          alerting: false,
          reason: "fixture resolution or setup failed",
        },
        setupFailure: "no such release asset",
      }),
    );
    expect(text).toMatch(/setup-failed/);
    expect(text.match(/setup-failed/g) ?? []).toHaveLength(1);
    expect(text).toContain("no such release asset");
  });

  test("a setup failure says what broke and what to do about it", () => {
    const text = render(
      makeReport({
        outcome: "setup-failed",
        assessment: {
          kind: "setup-failed",
          exitCode: 4,
          alerting: false,
          reason: "fixture resolution or setup failed",
        },
        setupFailure: "local platform up failed with status 1",
        diagnosis: [
          "Backend image pull failed",
          "Boot step 'backend-image' failed",
        ],
      }),
    );
    // The lines that looked wrong are restated: by summary time they have
    // scrolled out of view.
    expect(text).toContain("Backend image pull failed");
    expect(text).toMatch(/^ {3}diagnosis │ /m);
    // And the run says how to dig further, rather than stopping at "failed".
    expect(text).toMatch(/^ {8}next │ re-run with --verbose/m);
  });

  test("evidence drops compose scaffolding and container ANSI", () => {
    const text = render(
      makeReport({
        evidence: [
          {
            name: "edge_panic_context",
            stream: "edge",
            pattern: "panicked at",
            source: "/repo/compose.log",
            matches: [
              {
                line: 56,
                context: [
                  "edge-1   | 2026-08-06T06:17:25.478120719Z ",
                  `edge-1   | 2026-08-06T06:17:25.478156802Z ${ESC}[2mthread 'x' panicked at store.rs:202${ESC}[0m`,
                  "edge-1   | 2026-08-06T06:17:25.478163528Z   left: StoreId(1025)",
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(text).toContain("1 match, first at line 56"); // singular
    // Prefix and container escapes are gone; the message and its indentation
    // survive.
    expect(text).not.toContain("edge-1");
    expect(text).not.toContain(ESC);
    expect(text).toContain("thread 'x' panicked at store.rs:202");
    expect(text).toContain("  left: StoreId(1025)");
    // A line carrying nothing but scaffolding is dropped entirely.
    expect(text).not.toMatch(/^ +$/m);
  });

  test("a long failure message wraps instead of losing its tail", () => {
    const failure =
      "docker pull 658661676544.dkr.ecr.us-east-1.amazonaws.com/stackmachine:v1 " +
      "failed: not authorized to perform ecr:BatchGetImage on that repository";
    const text = render(
      makeReport({
        outcome: "setup-failed",
        assessment: {
          kind: "setup-failed",
          exitCode: 4,
          alerting: false,
          reason: "fixture resolution or setup failed",
        },
        setupFailure: failure,
      }),
    );
    // Every word survives — truncating the payload is worst exactly when the
    // payload is why the run failed.
    for (const word of [
      "ecr:BatchGetImage",
      "not",
      "authorized",
      "stackmachine",
    ]) {
      expect(text).toContain(word);
    }
    expect(text).not.toContain("…");
    // Continuations are hanging-indented so they read as one message.
    expect(text).toMatch(/^ {12} │ {3}\S/m);
    for (const line of text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  test("long evidence lines are truncated to the width", () => {
    const text = render(
      makeReport({
        evidence: [
          {
            name: "wide",
            stream: "edge",
            pattern: "panicked at",
            source: null,
            matches: [
              { line: 1, context: [`x panicked at ${"y".repeat(400)}`] },
            ],
          },
        ],
      }),
    );
    for (const line of text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    expect(text).toContain("…");
  });

  test("cleanup errors and workload timeouts are surfaced", () => {
    const text = render(
      makeReport({
        cleanupErrors: ["compose down timed out"],
        workload: {
          startedAt: "",
          finishedAt: "",
          exitCode: 137,
          counters: {},
          timedOut: true,
          logs: {},
        },
      }),
    );
    expect(text).toContain("cleanup error: compose down timed out");
    expect(text).toContain("hit the executor timeout");
  });
});

describe("style helpers", () => {
  test("formatSeconds switches to minutes past a minute", () => {
    expect(formatSeconds(0.4)).toBe("0.4s");
    expect(formatSeconds(39.44)).toBe("39.4s");
    expect(formatSeconds(174)).toBe("2m54s");
    expect(formatSeconds(393)).toBe("6m33s");
    expect(formatSeconds(1344)).toBe("22m24s");
  });

  test("truncate counts visible characters", () => {
    expect(truncate("abcdef", 10)).toBe("abcdef");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate(`${ESC}[31mabcdef${ESC}[0m`, 4)).toBe("abc…");
  });

  test("the divider rule fades out monotonically", () => {
    // Colour off: a plain rule, no escapes to leak into a log or CI.
    expect(fade("─", 6, { color: false })).toBe("──────");
    expect(fade("─", 0, { color: true })).toBe("");

    // Truecolor: one interpolated step per character.
    const rich = fade("─", 15, { color: true, depth: "truecolor" });
    expect(stripAnsi(rich)).toBe("─".repeat(15));
    const rgb = (rich.match(/38;2;\d+;\d+;\d+/g) ?? []).map((code) =>
      code.slice("38;2;".length).split(";").map(Number),
    );
    expect(rgb).toHaveLength(15);
    expect(rgb[0]).toEqual([95, 175, 255]); // frame blue
    expect(rgb.at(-1)).toEqual([58, 58, 58]); // dark neutral
    // The whole point of the rewrite: luminance never climbs back up, so the
    // rule cannot look more intense partway along.
    const luminance = rgb.map(
      ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b,
    );
    for (let i = 1; i < luminance.length; i++) {
      expect(luminance[i]).toBeLessThan(luminance[i - 1]);
    }

    // 256-colour quantisation keeps the same shape, monotonic and blue-first.
    const paletted = fade("─", 15, { color: true, depth: "256" });
    const codes = (paletted.match(/38;5;\d+/g) ?? []).map((code) =>
      Number(code.slice("38;5;".length)),
    );
    expect(codes).toHaveLength(15);
    expect(stripAnsi(paletted)).toBe("─".repeat(15));

    // 16-colour terminals get two tones instead of unsupported palette codes.
    const basic = fade("─", 15, { color: true, depth: "basic" });
    expect(stripAnsi(basic)).toBe("─".repeat(15));
    expect(basic).not.toContain("38;");
    expect(basic).toContain(`${ESC}[94m─────`);
    expect(basic).toContain(`${ESC}[90m`);
  });

  test("keys and frame differ in hue, not just brightness", () => {
    const text = formatSummary(makeReport(), "/repo/x.json", {
      color: true,
      width: 80,
      cwd: "/repo",
      depth: "truecolor",
    }).join("\n");
    // The key carries the warm tone; the frame beside it stays cool blue.
    expect(text).toMatch(new RegExp(`${ESC}\\[38;2;176;156;130m\\s*outcome`));
    expect(text).toContain(`${ESC}[38;2;95;175;255m│`);
    // Two blues were indistinguishable in practice, so the pair has to differ
    // in hue as well as luminance: cool frame, warm key.
    const [keyR, , keyB] = KEY_RGB;
    const [frameR, , frameB] = FRAME_RGB;
    expect(keyR - keyB).toBeGreaterThan(0); // warm: red over blue
    expect(frameR - frameB).toBeLessThan(0); // cool: blue over red
    const lum = ([r, g, b]: readonly [number, number, number]): number =>
      0.2126 * r + 0.7152 * g + 0.0722 * b;
    expect(lum(KEY_RGB)).toBeLessThan(lum(FRAME_RGB));
  });

  test("tint degrades to plain blue on a 16-colour terminal", () => {
    expect(tint("outcome", KEY_RGB, { color: false })).toBe("outcome");
    expect(tint("outcome", KEY_RGB, { color: true, depth: "basic" })).toBe(
      `${ESC}[34moutcome${ESC}[0m`,
    );
  });

  test("rgbTo256 picks the grey ramp over the cube for neutrals", () => {
    expect(rgbTo256(95, 175, 255)).toBe(75); // exact cube hit
    expect(rgbTo256(58, 58, 58)).toBe(237); // grey ramp beats the cube here
    expect(rgbTo256(0, 0, 0)).toBe(16);
  });

  test("colorDepth sniffs the terminal, not the TTY", () => {
    expect(colorDepth({ COLORTERM: "truecolor" })).toBe("truecolor");
    expect(colorDepth({ COLORTERM: "24bit" })).toBe("truecolor");
    expect(colorDepth({ TERM: "xterm-256color" })).toBe("256");
    expect(colorDepth({ TERM: "xterm" })).toBe("basic");
    expect(colorDepth({})).toBe("basic");
  });

  test("colorEnabled honors NO_COLOR over a TTY", () => {
    const previous = process.env["NO_COLOR"];
    try {
      process.env["NO_COLOR"] = "1";
      expect(colorEnabled({ isTTY: true })).toBe(false);
      delete process.env["NO_COLOR"];
      expect(colorEnabled({ isTTY: true })).toBe(true);
      expect(colorEnabled({ isTTY: false })).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env["NO_COLOR"];
      } else {
        process.env["NO_COLOR"] = previous;
      }
    }
  });
});
