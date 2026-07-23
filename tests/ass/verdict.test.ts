// Verdict-engine tests (Phase 2): four-way outcome derivation, combinator
// semantics, compose-log stream filtering, unavailable-stream handling, and
// collect evidence extraction.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedState, RunOutcome } from "../../ass/executors/contract";
import {
  evaluateVerdict,
  localStreamSources,
  type StreamSources,
} from "../../ass/engine/verdict";
import { parseScenario, type Verdict } from "../../ass/scenario/schema";

const tmpRoots: string[] = [];
afterAll(() => {
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeVerdict(verdict: Record<string, unknown>): Verdict {
  const scenario = parseScenario(
    {
      meta: { id: "X", title: "t" },
      load: { executor: "jest", jest: { spec: "x" } },
      verdict,
    },
    "draft",
  );
  return scenario.verdict!;
}

function makeOutcome(logs: Record<string, string> = {}): RunOutcome {
  return {
    startedAt: "2026-08-05T00:00:00Z",
    finishedAt: "2026-08-05T00:01:00Z",
    counters: {},
    logs,
    exitCode: 0,
  };
}

function sourcesFrom(streams: Record<string, string[] | null>): StreamSources {
  return {
    read: (stream) => streams[stream] ?? null,
    sourceOf: (stream) => (streams[stream] ? `/captures/${stream}.log` : null),
  };
}

const EDGE_PANIC = makeVerdict({
  reproduced_when: {
    any: [
      {
        log_matches: {
          stream: "edge",
          pattern: "object used with the wrong context",
        },
      },
    ],
  },
});

describe("outcome derivation", () => {
  test("matching reproduced_when is reproduced, with the predicate path", () => {
    const result = evaluateVerdict(
      EDGE_PANIC,
      makeOutcome(),
      sourcesFrom({ edge: ["object used with the wrong context"] }),
    );
    expect(result.outcome).toBe("reproduced");
    expect(result.matchedPredicates).toEqual([
      "verdict.reproduced_when.any[0]",
    ]);
  });

  test("no match without not_reproduced_when is not-reproduced", () => {
    const result = evaluateVerdict(
      EDGE_PANIC,
      makeOutcome(),
      sourcesFrom({ edge: ["all quiet"] }),
    );
    expect(result.outcome).toBe("not-reproduced");
  });

  test("declared not_reproduced_when separates healthy from inconclusive", () => {
    const verdict = makeVerdict({
      reproduced_when: {
        any: [{ log_matches: { stream: "edge", pattern: "panic" } }],
      },
      not_reproduced_when: {
        all: [{ log_matches: { stream: "edge", pattern: "healthy" } }],
      },
    });
    const healthy = evaluateVerdict(
      verdict,
      makeOutcome(),
      sourcesFrom({ edge: ["healthy"] }),
    );
    expect(healthy.outcome).toBe("not-reproduced");

    const silent = evaluateVerdict(
      verdict,
      makeOutcome(),
      sourcesFrom({ edge: ["nothing to see"] }),
    );
    expect(silent.outcome).toBe("inconclusive");
    expect(silent.reason).toContain("never folded into not-reproduced");
  });

  test("an unavailable stream yields inconclusive naming the stream", () => {
    const result = evaluateVerdict(
      EDGE_PANIC,
      makeOutcome(),
      sourcesFrom({ edge: null }),
    );
    expect(result.outcome).toBe("inconclusive");
    expect(result.unavailableStreams).toEqual(["edge"]);
    expect(result.reason).toContain("unavailable stream");
  });

  test("nested any/all combinators evaluate structurally", () => {
    const verdict = makeVerdict({
      reproduced_when: {
        all: [
          { log_matches: { stream: "edge", pattern: "panic" } },
          {
            any: [
              { log_matches: { stream: "backend", pattern: "500" } },
              { log_matches: { stream: "edge", pattern: "abort" } },
            ],
          },
        ],
      },
    });
    const hit = evaluateVerdict(
      verdict,
      makeOutcome(),
      sourcesFrom({ edge: ["panic", "abort"], backend: ["ok"] }),
    );
    expect(hit.outcome).toBe("reproduced");

    const miss = evaluateVerdict(
      verdict,
      makeOutcome(),
      sourcesFrom({ edge: ["panic"], backend: ["ok"] }),
    );
    expect(miss.outcome).toBe("not-reproduced");
  });
});

describe("workload output predicates", () => {
  function outcomeWithLogs(stdout: string, stderr: string): RunOutcome {
    const dir = mkdtempSync(path.join(tmpdir(), "ass-verdict-"));
    tmpRoots.push(dir);
    const stdoutFile = path.join(dir, "stdout.log");
    const stderrFile = path.join(dir, "stderr.log");
    writeFileSync(stdoutFile, stdout);
    writeFileSync(stderrFile, stderr);
    return makeOutcome({ stdout: stdoutFile, stderr: stderrFile });
  }

  test("output_matches defaults to both streams and honors stream:", () => {
    const both = makeVerdict({
      reproduced_when: { any: [{ output_matches: { pattern: "ECONNRESET" } }] },
    });
    const stderrOnly = makeVerdict({
      reproduced_when: {
        any: [{ output_matches: { stream: "stdout", pattern: "ECONNRESET" } }],
      },
    });
    const outcome = outcomeWithLogs("clean run", "socket ECONNRESET");
    const sources = sourcesFrom({});
    expect(evaluateVerdict(both, outcome, sources).outcome).toBe("reproduced");
    expect(evaluateVerdict(stderrOnly, outcome, sources).outcome).toBe(
      "not-reproduced",
    );
  });
});

describe("local stream sources", () => {
  test("platform streams filter the compose log by service prefix", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ass-compose-"));
    tmpRoots.push(dir);
    const composeLog = path.join(dir, "compose.follow.log");
    writeFileSync(
      composeLog,
      [
        "edge-1     | boot",
        "backend-1  | panic in backend",
        "edge-1     | panic in edge",
        "vector-1   | shipping",
      ].join("\n"),
    );
    const state = {
      env: "local",
      variables: {},
      components: {},
      pins: {},
      execEnv: {},
      artifactsDir: dir,
      composeLogPath: composeLog,
      cleanup: async () => [],
    } satisfies ResolvedState;
    const sources = localStreamSources(state);
    expect(sources.read("edge")).toEqual([
      "edge-1     | boot",
      "edge-1     | panic in edge",
    ]);
    expect(sources.read("backend")).toEqual(["backend-1  | panic in backend"]);
    expect(sources.sourceOf("edge")).toBe(composeLog);
    // App-instance capture is not implemented locally yet (Phases 4/5).
    expect(sources.read("app")).toBeNull();
  });
});

describe("collect evidence", () => {
  test("extracts context blocks, caps matches, and notes missing streams", () => {
    const verdict = makeVerdict({
      reproduced_when: {
        any: [{ log_matches: { stream: "edge", pattern: "panicked at" } }],
      },
      collect: [
        {
          edge_panic_context: {
            stream: "edge",
            pattern: "panicked at",
            before: 1,
            after: 2,
          },
        },
        { ghost: { stream: "backend", pattern: "x" } },
      ],
    });
    const edgeLines = [
      "before-line",
      "thread panicked at store.rs",
      "note: object used with the wrong context",
      "backtrace line",
      "unrelated",
    ];
    const result = evaluateVerdict(
      verdict,
      makeOutcome(),
      sourcesFrom({ edge: edgeLines, backend: null }),
    );
    expect(result.outcome).toBe("reproduced");
    const [panic, ghost] = result.evidence;
    expect(panic.matches).toEqual([
      {
        line: 2,
        context: [
          "before-line",
          "thread panicked at store.rs",
          "note: object used with the wrong context",
          "backtrace line",
        ],
      },
    ]);
    expect(panic.source).toBe("/captures/edge.log");
    expect(ghost.matches).toEqual([]);
    expect(ghost.note).toContain("not captured");
  });
});
