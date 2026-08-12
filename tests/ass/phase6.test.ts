// Phase 6: report hardening (schema validation, redaction, unwritable-dir
// tolerance, recoverability), the D6 alerting seam through the real CLI,
// `ass audit`, and the pipeline workflow's config invariants.

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  redactReport,
  secretsOf,
  writeReport,
  type RunReport,
} from "../../ass/report/report";
import {
  addScenario,
  cli,
  makeFakeHarness,
  makeRoot,
  PERSISTED_YAML,
} from "./helpers";

function minimalReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    scenario: {
      id: "T-1",
      title: "a test report",
      slug: "testy",
      lifecycle: { state: "open" },
    },
    target: { env: "local", mode: "pinned" },
    selectors: {},
    components: {},
    executor: { name: "jest", profile: { spec: "tests/x.test.ts" } },
    outcome: "not-reproduced",
    assessment: {
      kind: "candidate-fix",
      exitCode: 0,
      alerting: false,
      reason: "quiet on current versions",
    },
    verdict: null,
    evidence: [],
    workload: null,
    timing: {
      startedAt: "2026-08-10T00:00:00Z",
      finishedAt: "2026-08-10T00:01:00Z",
      seconds: 60,
      phases: [],
    },
    setupFailure: null,
    diagnosis: [],
    cleanupErrors: [],
    ...overrides,
  };
}

describe("report hardening (QA-641)", () => {
  test("a malformed report is an internal fault, never written", () => {
    const dir = makeRoot();
    const bad = minimalReport({
      outcome: "sort-of-reproduced" as RunReport["outcome"],
    });
    expect(() => writeReport(path.join(dir, "report.json"), bad)).toThrow(
      /internal: run report failed schema validation/,
    );
  });

  test("redaction scrubs secret values wherever they appear", () => {
    const report = minimalReport({
      diagnosis: ["auth header was Bearer sk-hunter2-hunter2"],
      evidence: [
        {
          name: "leaky",
          stream: "app",
          pattern: "x",
          source: null,
          matches: [{ line: 3, context: ["token sk-hunter2-hunter2 refused"] }],
        },
      ] as RunReport["evidence"],
    });
    const secrets = secretsOf({
      WASMER_TOKEN: "sk-hunter2-hunter2",
      WASMER_REGISTRY: "https://registry.wasmer.wtf/graphql",
      SHORTY: "ab", // sensitive-looking values under 6 chars are ignored
    });
    expect(secrets).toEqual(["sk-hunter2-hunter2"]);
    const clean = JSON.stringify(redactReport(report, secrets));
    expect(clean).not.toContain("sk-hunter2-hunter2");
    expect(clean).toContain("[redacted]");
    // The registry URL is not a secret and must survive.
    expect(JSON.stringify(redactReport(report, secrets))).toBe(clean);
  });

  test("a secret captured in remote evidence never reaches the report file", async () => {
    const root = makeRoot();
    addScenario(
      root,
      "repros",
      "leaky",
      `
meta:
  id: LK-1
  title: evidence quotes a log line carrying a token
  lifecycle: { state: open }
fixtures:
  probes:
    matrix:
      source: package:./probe
load:
  executor: artillery-http
  artillery-http:
    target: "{{ matrix.url }}"
    scenarios:
      - flow: [{ get: { url: "/" } }]
verdict:
  reproduced_when:
    any:
      - log_matches: { stream: app, pattern: "deadlock detected" }
  collect:
    - leak_context: { stream: app, pattern: "deadlock detected" }
  baseline:
    waived: n/a
`,
    );
    const harness = makeFakeHarness({
      remoteLogs:
        "deadlock detected while holding fake-secret-token-do-not-serialize\n",
      workload: { code: 0, stdout: "", stderr: "" },
    });
    const result = await cli(
      root,
      ["run", "leaky", "--env", "dev"],
      harness.deps,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("reproduced");
    expect(result.stdout).not.toContain("fake-secret-token");
    const reportsDir = path.join(root, ".local-platform", "ass", "runs");
    const { readdirSync } = await import("node:fs");
    const reportFiles = readdirSync(reportsDir).map((entry) =>
      path.join(reportsDir, entry, "report.json"),
    );
    expect(reportFiles.length).toBeGreaterThan(0);
    for (const file of reportFiles) {
      const content = readFileSync(file, "utf8");
      expect(content).not.toContain("fake-secret-token");
      expect(content).toContain("[redacted]");
    }
  });

  test("an unwritable report path costs the file, never the verdict", async () => {
    const root = makeRoot();
    addScenario(root, "repros", "wax-600", PERSISTED_YAML);
    const harness = makeFakeHarness();
    // The report path itself is a directory, so the write must fail while
    // setup (which only needs the parent) succeeds.
    mkdirSync(path.join(harness.runDir, "ass", "report.json"), {
      recursive: true,
    });
    const result = await cli(root, ["run", "wax-600"], harness.deps);
    expect(result.stdout).toContain("could not write the run report");
    expect(result.stdout).toContain("reproduced"); // verdict still delivered
    expect(result.code).toBe(0); // expected assessment, not an error exit
  });

  test("fixture versions, executor, target, load shape, verdict and logs are recoverable", async () => {
    const root = makeRoot();
    addScenario(root, "repros", "wax-600", PERSISTED_YAML);
    const harness = makeFakeHarness();
    const result = await cli(root, ["run", "wax-600"], harness.deps);
    expect(result.code).toBe(0);
    const report = JSON.parse(
      readFileSync(path.join(harness.runDir, "ass", "report.json"), "utf8"),
    ) as RunReport;
    expect(report.scenario.slug).toBe("wax-600");
    expect(report.target).toEqual({ env: "local", mode: "pinned" });
    expect(report.selectors["edge"]).toContain("github-release:");
    expect(report.components["edge"]).toContain("github-release:");
    expect(report.executor?.name).toBe("jest");
    expect(report.executor?.profile["spec"]).toBe(
      "tests/app/templates.test.ts",
    );
    expect(report.outcome).toBe("reproduced");
    expect(report.assessment.kind).toBe("expected");
    expect(report.verdict?.["matchedPredicates"]).toBeDefined();
    expect(report.workload?.command?.join(" ")).toContain("jest");
    for (const file of Object.values(report.workload?.logs ?? {})) {
      expect(readFileSync(file, "utf8")).toBeDefined();
    }
    expect(report.timing.phases.map((phase) => phase.name)).toEqual(
      expect.arrayContaining(["setup", "workload", "cleanup"]),
    );
  });
});

describe("the alerting seam (D6) through the real CLI", () => {
  const FIXED_YAML = PERSISTED_YAML.replace(
    "lifecycle: { state: open }",
    `lifecycle:
    state: fixed
    fixed_in: { edge: "github-release:wasmerio/edge:v2026-08-05_1_419b336_dev1:edge" }
    fixed_at: "2026-08-08"
    evidence: worklog run 20260808`,
  );

  test("a fixed scenario reproducing on floating selectors alerts (exit 2)", async () => {
    const root = makeRoot();
    addScenario(root, "repros", "wax-600", FIXED_YAML);
    const harness = makeFakeHarness();
    const result = await cli(
      root,
      ["run", "wax-600", "--edge", "resolve_prod"],
      harness.deps,
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("alert");
  });

  test("the same fact under an open lifecycle on pins stays quiet (exit 0)", async () => {
    const root = makeRoot();
    addScenario(root, "repros", "wax-600", PERSISTED_YAML);
    const harness = makeFakeHarness();
    const result = await cli(root, ["run", "wax-600"], harness.deps);
    expect(result.code).toBe(0);
  });
});

describe("ass audit", () => {
  function plantReport(
    root: string,
    stamp: string,
    overrides: Partial<RunReport>,
  ): void {
    const dir = path.join(root, ".local-platform", "ass", "runs", stamp);
    mkdirSync(dir, { recursive: true });
    writeReport(path.join(dir, "report.json"), minimalReport(overrides));
  }

  const FIXED_SCENARIO = `
meta:
  id: FX-1
  title: a fixed scenario
  lifecycle:
    state: fixed
    fixed_in: { edge: "github-release:wasmerio/edge:v9:edge" }
    fixed_at: "2026-08-01"
    evidence: some run
fixtures:
  components:
    edge: github-release:wasmerio/edge:v1:edge
load:
  executor: jest
  jest:
    spec: tests/x.test.ts
verdict:
  reproduced_when:
    any:
      - output_matches: { pattern: kaboom }
  baseline:
    waived: n/a
`;

  test("lists open scenarios stalest-first and never-run", async () => {
    const root = makeRoot();
    addScenario(root, "repros", "oldy", PERSISTED_YAML);
    addScenario(
      root,
      "repros",
      "newy",
      PERSISTED_YAML.replace("id: WAX-600", "id: WAX-601"),
    );
    plantReport(root, "a", {
      scenario: {
        id: "WAX-601",
        title: "t",
        slug: "newy",
        lifecycle: { state: "open" },
      },
      outcome: "reproduced",
      timing: {
        startedAt: "2026-08-01T00:00:00Z",
        finishedAt: "2026-08-01T00:01:00Z",
        seconds: 60,
        phases: [],
      },
    });
    const result = await cli(root, ["audit"]);
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    const openIdx = lines.findIndex((line) => line.startsWith("open"));
    expect(lines[openIdx]).toContain("(2)");
    // never-run sorts before the one with a recorded run
    expect(lines[openIdx + 1]).toContain("oldy");
    expect(lines[openIdx + 1]).toContain("never run on this machine");
    expect(lines[openIdx + 2]).toContain("newy");
    expect(lines[openIdx + 2]).toMatch(/last run \d+ days ago/);
  });

  test("a fixed scenario whose latest floating run reproduced exits 2", async () => {
    const root = makeRoot();
    addScenario(root, "repros", "fixy", FIXED_SCENARIO);
    plantReport(root, "b", {
      scenario: {
        id: "FX-1",
        title: "t",
        slug: "fixy",
        lifecycle: { state: "fixed" } as RunReport["scenario"]["lifecycle"],
      },
      target: { env: "dev", mode: "floating" },
      outcome: "reproduced",
      assessment: {
        kind: "alert",
        exitCode: 2,
        alerting: true,
        reason: "repro on floating under fixed lifecycle",
      },
    });
    const result = await cli(root, ["audit"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("REGRESSION");
    expect(result.stdout).toContain("fixy");
  });

  test("a fixed scenario quiet on floating stays exit 0", async () => {
    const root = makeRoot();
    addScenario(root, "repros", "fixy", FIXED_SCENARIO);
    plantReport(root, "c", {
      scenario: {
        id: "FX-1",
        title: "t",
        slug: "fixy",
        lifecycle: { state: "fixed" } as RunReport["scenario"]["lifecycle"],
      },
      target: { env: "dev", mode: "floating" },
      outcome: "not-reproduced",
    });
    const result = await cli(root, ["audit"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("quiet on floating");
  });

  test("an unloadable repro is named without taking the audit down", async () => {
    const root = makeRoot();
    addScenario(root, "repros", "goody", PERSISTED_YAML);
    addScenario(root, "repros", "broken", "meta: [this is not a scenario\n");
    const result = await cli(root, ["audit"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("unloadable scenarios (1):");
    expect(result.stdout).toContain("broken");
    expect(result.stdout).toContain("goody"); // the rest still audited
  });

  test("retired scenarios list their successor and drafts are ignored", async () => {
    const root = makeRoot();
    addScenario(
      root,
      "repros",
      "oldie",
      PERSISTED_YAML.replace(
        "lifecycle: { state: open }",
        'lifecycle: { state: retired, superseded_by: "tests/validation/x.test.ts" }',
      ),
    );
    addScenario(root, "experiments", "drafty", PERSISTED_YAML);
    const result = await cli(root, ["audit"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("superseded by tests/validation/x.test.ts");
    expect(result.stdout).not.toContain("drafty");
  });
});

describe("the pipeline workflow (QA-642)", () => {
  const workflowPath = path.resolve(
    __dirname,
    "..",
    "..",
    ".github",
    "workflows",
    "ass-run.yaml",
  );
  const raw = readFileSync(workflowPath, "utf8");
  // `on:` parses as boolean true in YAML 1.1; js-yaml maps it to the string
  // key "true" — read it back defensively.
  const workflow = loadYaml(raw) as Record<string, unknown>;
  const triggers = (workflow["on"] ?? workflow["true"] ?? {}) as Record<
    string,
    unknown
  >;

  test("is dispatchable and callable with scenario/env/executor/threshold inputs", () => {
    const dispatch = triggers["workflow_dispatch"] as {
      inputs: Record<string, { required?: boolean; options?: string[] }>;
    };
    expect(dispatch.inputs["scenario"].required).toBe(true);
    expect(dispatch.inputs["env"].options).toEqual([
      "local",
      "dev",
      "bugtopia",
    ]);
    expect(dispatch.inputs["executor"]).toBeDefined();
    expect(dispatch.inputs["fail_threshold"].options).toEqual([
      "alert",
      "inconclusive",
    ]);
    const call = triggers["workflow_call"] as {
      inputs: Record<string, unknown>;
    };
    for (const input of ["scenario", "env", "executor", "fail_threshold"]) {
      expect(call.inputs[input]).toBeDefined();
    }
  });

  test("production is not a dispatchable environment (interactive gates cannot run in CI)", () => {
    const dispatch = triggers["workflow_dispatch"] as {
      inputs: Record<string, { options?: string[] }>;
    };
    expect(dispatch.inputs["env"].options).not.toContain("prod");
  });

  test("no cron schedule exists until Bugtopia is qualified (D5)", () => {
    expect(triggers["schedule"]).toBeUndefined();
    expect(raw).toContain("QA-643");
  });

  test("nothing fires the pipeline implicitly — dispatch and call only", () => {
    // The validation-only push trigger is gone; a scenario run costs a real
    // environment, so it must always be an explicit request.
    expect(Object.keys(triggers).sort()).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
  });

  test("a missing report artifact is a visible failure, never quietly green", () => {
    expect(raw).toContain("if-no-files-found: error");
  });

  test("the exit-code mapping alerts on the assessment, not the verdict", () => {
    // Exit 2 (alerting assessment) always fails; exit 3 fails only under
    // the stricter threshold; exit 0 (incl. an open scenario reproducing on
    // pins) passes.
    expect(raw).toContain('case "$code" in');
    expect(raw).toMatch(/3\).*FAIL_THRESHOLD.*alert.*exit 0.*exit 3/);
  });
});
