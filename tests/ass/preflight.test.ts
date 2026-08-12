// Unit tests for the D7 capability table and verdict preflight: an
// environment-observable predicate on a target with no adapter fails
// preflight — naming predicate, stream, and target — before any fixture
// resolution; app instance streams evaluate everywhere (D11).

import {
  classifyPredicate,
  isLogStreamEvaluable,
  preflightVerdict,
  PreflightError,
} from "../../ass/engine/capabilities";
import { parseScenario } from "../../ass/scenario/schema";
import type { TargetEnv } from "../../ass/executors/contract";

function scenarioWithVerdict(verdict: Record<string, unknown>) {
  return parseScenario(
    {
      meta: { id: "WAX-1", title: "preflight fixture" },
      load: { executor: "jest", jest: { spec: "x" } },
      verdict,
    },
    "draft",
  );
}

describe("capability table", () => {
  test.each<[string, TargetEnv, boolean]>([
    ["edge", "local", true],
    ["edge", "dev", false],
    ["edge", "bugtopia", false],
    ["edge", "prod", false],
    ["backend", "dev", false],
    ["app", "local", true],
    ["app", "prod", true],
    ["stdout", "dev", true],
    ["stderr", "bugtopia", true],
    ["egde", "local", false],
    ["egde", "dev", false],
  ])("log stream %s on %s evaluable: %p", (stream, env, evaluable) => {
    expect(isLogStreamEvaluable(stream, env)).toBe(evaluable);
  });

  test("predicate classes follow the predicate kind", () => {
    expect(
      classifyPredicate({ log_matches: { stream: "edge", pattern: "p" } }),
    ).toBe("environment-observable");
    expect(classifyPredicate({ output_matches: { pattern: "p" } })).toBe(
      "executor-observable",
    );
  });
});

describe("preflightVerdict", () => {
  const platformLogVerdict = {
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
  };

  test("platform process stream on a remote target fails, naming predicate, stream, and target", () => {
    const scenario = scenarioWithVerdict(platformLogVerdict);
    let error: unknown;
    try {
      preflightVerdict(scenario, "dev", "jest");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PreflightError);
    const message = (error as PreflightError).message;
    expect(message).toContain("verdict.reproduced_when.any[0]");
    expect(message).toContain('"edge"');
    expect(message).toContain('"dev"');
    expect(message).toContain("no fixtures were resolved");
  });

  test("the same verdict passes preflight on local", () => {
    const scenario = scenarioWithVerdict(platformLogVerdict);
    expect(() => preflightVerdict(scenario, "local", "jest")).not.toThrow();
  });

  test("an unknown stream fails preflight on every target, naming the known set", () => {
    const scenario = scenarioWithVerdict({
      reproduced_when: {
        any: [{ log_matches: { stream: "egde", pattern: "panic" } }],
      },
    });
    for (const env of ["local", "dev", "bugtopia", "prod"] as const) {
      let error: unknown;
      try {
        preflightVerdict(scenario, env, "jest");
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(PreflightError);
      const message = (error as PreflightError).message;
      expect(message).toContain('unknown stream "egde"');
      expect(message).toContain("known streams: app, stdout, stderr");
    }
  });

  test("nested combinators are walked", () => {
    const scenario = scenarioWithVerdict({
      reproduced_when: {
        all: [
          { output_matches: { pattern: "500" } },
          { any: [{ log_matches: { stream: "backend", pattern: "panic" } }] },
        ],
      },
    });
    expect(() => preflightVerdict(scenario, "bugtopia", "jest")).toThrow(
      PreflightError,
    );
  });

  test("app instance streams and executor-observable predicates pass everywhere", () => {
    const scenario = scenarioWithVerdict({
      reproduced_when: {
        any: [
          { log_matches: { stream: "app", pattern: "panic" } },
          { output_matches: { pattern: "500" } },
        ],
      },
      probe: {
        channels: [
          { type: "log", stream: "stderr" },
          { type: "http", match: "body" },
        ],
      },
    });
    for (const env of ["local", "dev", "bugtopia", "prod"] as const) {
      expect(() => preflightVerdict(scenario, env, "jest")).not.toThrow();
    }
  });

  test("an invalid regex pattern fails preflight naming the predicate path (R3-01)", () => {
    // Statically unevaluable (D7): must die here, not after a full boot
    // and workload as a raw SyntaxError with no report.
    const scenario = scenarioWithVerdict({
      reproduced_when: {
        any: [
          { log_matches: { stream: "edge", pattern: "panicked at [" } },
          { output_matches: { pattern: "(unclosed" } },
        ],
      },
      collect: [{ ctx: { stream: "edge", pattern: "bad(?<" } }],
    });
    let error: unknown;
    try {
      preflightVerdict(scenario, "local", "jest");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PreflightError);
    const message = (error as PreflightError).message;
    expect(message).toContain("verdict.reproduced_when.any[0]");
    expect(message).toContain("verdict.reproduced_when.any[1]");
    expect(message).toContain("verdict.collect[0].ctx");
    expect(message).toContain("Invalid regular expression");
  });

  test("a scenario without a verdict has nothing to preflight", () => {
    const scenario = parseScenario(
      {
        meta: { id: "WAX-1", title: "draft without verdict" },
        load: { executor: "jest", jest: { spec: "x" } },
      },
      "draft",
    );
    expect(() => preflightVerdict(scenario, "prod", "jest")).not.toThrow();
  });
});
