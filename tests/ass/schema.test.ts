// Unit tests for the ASS scenario schema (Phase 1 of
// worklogs/2026-07-24-anti-slop-shield): draft vs persisted validation,
// lifecycle union, load profiles, verdict/probe/baseline, fixture config.
// Covers the schema rows of the phase's error-coverage matrix.

import { ZodError } from "zod";
import { parseScenario } from "../../ass/scenario/schema";
import { classifySelector } from "../../ass/scenario/selectors";

function minimalDraft(): Record<string, unknown> {
  return {
    meta: { id: "WAX-1", title: "a minimal draft" },
    load: { executor: "jest", jest: { spec: "tests/app/x.test.ts" } },
  };
}

function validPersisted(): Record<string, unknown> {
  // Shape of the WAX-603 reference declaration (design doc §4).
  return {
    meta: {
      id: "WAX-603",
      title: "WASIX timed waits on threading primitives never expire",
      lifecycle: { state: "open" },
      links: { linear: "https://linear.app/wasmer/issue/WAX-603" },
    },
    fixtures: {
      probes: {
        matrix: { source: "package:./probe", config: { max_instances: 1 } },
      },
      components: { python: "registry:python/python@=3.13.5" },
    },
    load: {
      executor: "raw-wasmer",
      "raw-wasmer": { package: "{{ matrix.path }}", args: ["--once"] },
      "artillery-http": {
        scenarios: [{ flow: [{ get: { url: "{{ matrix.url }}/" } }] }],
      },
    },
    verdict: {
      probe: {
        channels: [
          { type: "log", stream: "stderr" },
          { type: "http", match: "body" },
        ],
      },
      baseline: {
        engine: "python3",
        entry: ["repro.py", "--once"],
        workdir: "{{ matrix.path }}",
        expect: "not-reproduced",
      },
    },
  };
}

function issuesOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ZodError) {
      return err.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("\n");
    }
    throw err;
  }
  throw new Error("expected a ZodError");
}

describe("draft validation", () => {
  test("minimal draft loads; lifecycle defaults to open", () => {
    const scenario = parseScenario(minimalDraft(), "draft");
    expect(scenario.meta.lifecycle).toEqual({ state: "open" });
    expect(scenario.load.activeExecutor).toBe("jest");
  });

  test("draft missing verdict loads successfully", () => {
    const scenario = parseScenario(minimalDraft(), "draft");
    expect(scenario.verdict).toBeUndefined();
  });

  test("draft may use floating component selectors", () => {
    const draft = minimalDraft();
    draft.fixtures = {
      components: { edge: "resolve_prod", backend: "path:/home/x/backend" },
    };
    const scenario = parseScenario(draft, "draft");
    expect(scenario.fixtures.components).toEqual({
      edge: "resolve_prod",
      backend: "path:/home/x/backend",
    });
  });

  test("single declared profile resolves as active without executor:", () => {
    const draft = minimalDraft();
    draft.load = { jest: { spec: "x" } };
    expect(parseScenario(draft, "draft").load.activeExecutor).toBe("jest");
  });
});

describe("persisted validation", () => {
  test("valid persisted declaration loads into typed data", () => {
    const scenario = parseScenario(validPersisted(), "persisted");
    expect(scenario.meta.lifecycle.state).toBe("open");
    expect(scenario.load.activeExecutor).toBe("raw-wasmer");
    expect(Object.keys(scenario.load.profiles).sort()).toEqual([
      "artillery-http",
      "raw-wasmer",
    ]);
    expect(scenario.verdict?.probe?.channels).toHaveLength(2);
  });

  test("floating selector is a strict-validation error naming the component", () => {
    const persisted = validPersisted();
    (persisted.fixtures as Record<string, unknown>).components = {
      python: "registry:python/python",
    };
    expect(issuesOf(() => parseScenario(persisted, "persisted"))).toMatch(
      /components\.python: persisted scenarios require pinned selectors/,
    );
  });

  test("missing verdict is a strict-validation error", () => {
    const persisted = validPersisted();
    delete (persisted as Record<string, unknown>).verdict;
    expect(issuesOf(() => parseScenario(persisted, "persisted"))).toMatch(
      /verdict: persisted scenarios require a verdict/,
    );
  });

  test("missing lifecycle is a strict-validation error", () => {
    const persisted = validPersisted();
    delete (persisted.meta as Record<string, unknown>).lifecycle;
    expect(issuesOf(() => parseScenario(persisted, "persisted"))).toMatch(
      /meta\.lifecycle: persisted scenarios require an explicit lifecycle/,
    );
  });

  test("neither baseline nor waiver is a strict-validation error", () => {
    const persisted = validPersisted();
    delete ((persisted.verdict as Record<string, unknown>) ?? {}).baseline;
    expect(issuesOf(() => parseScenario(persisted, "persisted"))).toMatch(
      /verdict\.baseline: persisted scenarios require verdict\.baseline/,
    );
  });

  test("reasoned waiver satisfies the baseline requirement", () => {
    const persisted = validPersisted();
    (persisted.verdict as Record<string, unknown>).baseline = {
      waived: "platform-level bug — no native analogue",
    };
    const scenario = parseScenario(persisted, "persisted");
    expect(scenario.verdict?.baseline).toEqual({
      waived: "platform-level bug — no native analogue",
    });
  });
});

describe("lifecycle union", () => {
  test("unknown state is rejected", () => {
    const draft = minimalDraft();
    (draft.meta as Record<string, unknown>).lifecycle = { state: "wontfix" };
    expect(issuesOf(() => parseScenario(draft, "draft"))).toMatch(
      /meta\.lifecycle/,
    );
  });

  test("fixed without fixed_in/fixed_at/evidence is rejected", () => {
    const draft = minimalDraft();
    (draft.meta as Record<string, unknown>).lifecycle = { state: "fixed" };
    const issues = issuesOf(() => parseScenario(draft, "draft"));
    expect(issues).toMatch(/fixed_in/);
    expect(issues).toMatch(/fixed_at/);
    expect(issues).toMatch(/evidence/);
  });

  test("fixed_in naming an undeclared component is rejected", () => {
    const persisted = validPersisted();
    (persisted.meta as Record<string, unknown>).lifecycle = {
      state: "fixed",
      fixed_in: { wasix: "v1" },
      fixed_at: "2026-08-01",
      evidence: "https://linear.app/wasmer/issue/WAX-603#comment",
    };
    expect(issuesOf(() => parseScenario(persisted, "persisted"))).toMatch(
      /fixed_in names undeclared component\(s\): wasix; declared components: python/,
    );
  });

  test("retired without superseded_by is rejected", () => {
    const draft = minimalDraft();
    (draft.meta as Record<string, unknown>).lifecycle = { state: "retired" };
    expect(issuesOf(() => parseScenario(draft, "draft"))).toMatch(
      /superseded_by/,
    );
  });
});

describe("load profiles", () => {
  test("missing load is a schema error", () => {
    const draft = minimalDraft();
    delete (draft as Record<string, unknown>).load;
    expect(issuesOf(() => parseScenario(draft, "draft"))).toMatch(/load/);
  });

  test("load with no profile is a schema error", () => {
    const draft = minimalDraft();
    draft.load = { executor: "jest" };
    expect(issuesOf(() => parseScenario(draft, "draft"))).toMatch(
      /load: load must declare at least one executor profile/,
    );
  });

  test("a profile naming no known executor is a schema error (Phase 4)", () => {
    const draft = minimalDraft();
    draft.load = { "jest-ish": { spec: "tests/x.test.ts" } };
    expect(issuesOf(() => parseScenario(draft, "draft"))).toMatch(
      /unknown executor "jest-ish"[\s\S]*Known executors: artillery-http, jest, raw-wasmer/,
    );
  });

  test("a profile may name its executor, so two can share one (D8)", () => {
    const draft = minimalDraft();
    draft.load = {
      executor: "current",
      current: { executor: "raw-wasmer", package: "python/python@3.13.5" },
      old: { executor: "raw-wasmer", package: "python/python@3.12.0" },
    };
    const scenario = parseScenario(draft, "draft");
    expect(scenario.load.activeExecutor).toBe("current");
    expect(scenario.load.executors).toEqual({
      current: "raw-wasmer",
      old: "raw-wasmer",
    });
    // `executor:` is addressing, not settings: the profile handed to the
    // executor's own strict schema must not carry it.
    expect(scenario.load.profiles["old"]).toEqual({
      package: "python/python@3.12.0",
    });
  });

  test("executor naming an undeclared profile is a schema error", () => {
    const draft = minimalDraft();
    draft.load = { executor: "artillery-http", jest: { spec: "x" } };
    expect(issuesOf(() => parseScenario(draft, "draft"))).toMatch(
      /executor "artillery-http" has no matching profile; declared profiles: jest/,
    );
  });

  test("several profiles without executor: is an ambiguity error", () => {
    const draft = minimalDraft();
    draft.load = { jest: { spec: "x" }, "raw-wasmer": { package: "p" } };
    expect(issuesOf(() => parseScenario(draft, "draft"))).toMatch(
      /ambiguous active executor/,
    );
  });
});

describe("verdict", () => {
  test("bare predicate list without any/all combinator is rejected", () => {
    const draft = minimalDraft();
    draft.verdict = {
      reproduced_when: [{ log_matches: { stream: "edge", pattern: "panic" } }],
    };
    expect(issuesOf(() => parseScenario(draft, "draft"))).toMatch(
      /explicit combinator/,
    );
  });

  test("nested any/all combinators load", () => {
    const draft = minimalDraft();
    draft.verdict = {
      reproduced_when: {
        all: [
          { log_matches: { stream: "edge", pattern: "panic" } },
          { any: [{ output_matches: { pattern: "500" } }] },
        ],
      },
    };
    expect(parseScenario(draft, "draft").verdict).toBeDefined();
  });

  test("verdict without reproduced_when or probe is rejected", () => {
    const draft = minimalDraft();
    draft.verdict = {
      not_reproduced_when: { any: [{ output_matches: { pattern: "ok" } }] },
    };
    expect(issuesOf(() => parseScenario(draft, "draft"))).toMatch(
      /reproduced_when: and\/or probe:/,
    );
  });

  test("unknown probe channel type names the open-union members", () => {
    const draft = minimalDraft();
    draft.verdict = { probe: { channels: [{ type: "file", path: "/v" }] } };
    const issues = issuesOf(() => parseScenario(draft, "draft"));
    expect(issues).toMatch(/unknown probe channel type/);
    expect(issues).toMatch(/"log"/);
    expect(issues).toMatch(/"http"/);
  });

  test("baseline engine binary requires command", () => {
    const draft = minimalDraft();
    draft.verdict = {
      probe: { channels: [{ type: "log", stream: "stderr" }] },
      baseline: { engine: "binary", entry: ["run"] },
    };
    expect(issuesOf(() => parseScenario(draft, "draft"))).toMatch(
      /engine "binary" requires an explicit command/,
    );
  });
});

describe("controls (D8)", () => {
  function draftWithControl(control: Record<string, unknown>) {
    const draft = minimalDraft();
    draft.verdict = {
      probe: { channels: [{ type: "log", stream: "stderr" }] },
      controls: { healthy: control },
    };
    return draft;
  }

  test("a native control (engine + entry) loads", () => {
    const draft = draftWithControl({
      engine: "python3",
      entry: ["control.py"],
      expect: "not-reproduced",
    });
    expect(parseScenario(draft, "draft").verdict?.controls).toBeDefined();
  });

  test("an executor control loads", () => {
    const draft = draftWithControl({ executor: "jest", expect: "reproduced" });
    expect(parseScenario(draft, "draft").verdict?.controls).toBeDefined();
  });

  test("executor control naming an undeclared profile lists the declared ones", () => {
    const draft = draftWithControl({
      executor: "artillery-http",
      expect: "reproduced",
    });
    expect(issuesOf(() => parseScenario(draft, "draft"))).toMatch(
      /verdict\.controls\.healthy\.executor: control "healthy" names undeclared executor profile "artillery-http"; declared profiles: jest/,
    );
  });

  test.each<[string, Record<string, unknown>, RegExp]>([
    [
      "expect alone is unrunnable",
      { expect: "reproduced" },
      /engine: \+ entry:\) or an executor:, not neither/,
    ],
    [
      "engine and executor together are ambiguous",
      {
        engine: "node",
        entry: ["c.js"],
        executor: "jest",
        expect: "reproduced",
      },
      /not both/,
    ],
    [
      "engine without entry",
      { engine: "node", expect: "reproduced" },
      /native control requires entry/,
    ],
    [
      "command without engine binary",
      { engine: "node", entry: ["c.js"], command: ["x"], expect: "reproduced" },
      /command: is only valid with engine "binary"/,
    ],
    [
      "entry on an executor control",
      { executor: "jest", entry: ["c.js"], expect: "reproduced" },
      /entry: is only valid on a native control/,
    ],
  ])("%s is rejected", (_name, control, expected) => {
    expect(
      issuesOf(() => parseScenario(draftWithControl(control), "draft")),
    ).toMatch(expected);
  });
});

describe("fixture config (D13)", () => {
  test("unknown config key is a schema error", () => {
    const draft = minimalDraft();
    draft.fixtures = {
      apps: { victim: { source: "template:x", config: { replicas: 2 } } },
    };
    expect(issuesOf(() => parseScenario(draft, "draft"))).toMatch(
      /fixtures\.apps\.victim\.config/,
    );
  });

  test.each([0, -1, 1.5])("max_instances %p is rejected", (value) => {
    const draft = minimalDraft();
    draft.fixtures = {
      apps: {
        victim: { source: "template:x", config: { max_instances: value } },
      },
    };
    expect(issuesOf(() => parseScenario(draft, "draft"))).toMatch(
      /max_instances/,
    );
  });

  test("valid max_instances loads", () => {
    const draft = minimalDraft();
    draft.fixtures = {
      apps: { victim: { source: "template:x", config: { max_instances: 1 } } },
    };
    expect(parseScenario(draft, "draft").fixtures.apps?.victim.config).toEqual({
      max_instances: 1,
    });
  });
});

describe("selector classification", () => {
  test.each([
    ["github-release:wasmerio/edge:v2026-07-16_1_fcdd9c4_dev1:edge", "pinned"],
    ["artifact:wasmerio/edge:12345:edge", "pinned"],
    ["registry:python/python@=3.13.5", "pinned"],
    ["url:https://example.com/edge.tar.gz", "pinned"],
    ["resolve_prod", "floating"],
    ["latest", "floating"],
    ["path:/home/x/edge", "floating"],
    ["github-artifact:wasmerio/edge:edge", "floating"],
    ["registry:python/python", "floating"],
    ["registry:python/python@3", "floating"],
    ["something-else", "floating"],
  ])("%s classifies as %s", (selector, mode) => {
    expect(classifySelector(selector).mode).toBe(mode);
  });
});
