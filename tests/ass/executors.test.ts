// Executor-contract tests (Phase 4): the common outcome shape, argv
// construction per executor, the D11 probe contract with its exit-status
// cross-check, native baselines and controls, and every preflight that must
// fire before a workload runs.
//
// The host-process executor is exercised as a *real* process wherever the
// assertion is about behaviour rather than wiring: python3 is already a
// required capability, and a spawned interpreter is the boundary this phase
// is about.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertRunOutcome,
  type ResolvedState,
  type RunOutcome,
  type WorkloadExec,
} from "../../ass/executors/contract";
import { resolveExecutor, findExecutor } from "../../ass/executors/registry";
import {
  buildArgv,
  parseRawWasmerProfile,
  selectBinary,
  executeRawWasmer,
} from "../../ass/executors/rawWasmer";
import {
  buildEngineArgv,
  executeHostProcess,
} from "../../ass/executors/hostProcess";
import {
  buildArtilleryScript,
  parseArtilleryProfile,
} from "../../ass/executors/artilleryHttp";
import {
  checkReference,
  interpolate,
  TemplateError,
  templateReferences,
} from "../../ass/executors/template";
import { evaluateProbe, readMarkers } from "../../ass/engine/probe";
import { PreflightError } from "../../ass/errors";
import { parseScenario } from "../../ass/scenario/schema";
import { addScenario, cli, makeFakeHarness, makeRoot } from "./helpers";

function stateIn(
  dir: string,
  variables: Record<string, string> = {},
): ResolvedState {
  return {
    env: "local",
    variables,
    components: {},
    pins: {},
    execEnv: {},
    artifactsDir: dir,
    composeLogPath: null,
    cleanup: async () => [],
  };
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "ass-exec-"));
}

/** A workload exec whose behaviour depends on which program was spawned, so
 * one test can give the workload and its baseline different stories. */
function scriptedExec(
  responses: Array<{
    match: RegExp;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    timedOut?: boolean;
    signal?: string | null;
  }>,
): WorkloadExec {
  return async (argv, opts) => {
    const joined = argv.join(" ");
    const response = responses.find((entry) => entry.match.test(joined));
    writeFileSync(opts.stdoutFile, response?.stdout ?? "");
    writeFileSync(opts.stderrFile, response?.stderr ?? "");
    return {
      exitCode: response?.exitCode ?? 0,
      timedOut: response?.timedOut ?? false,
      signal: response?.signal ?? null,
    };
  };
}

describe("the common outcome contract (AC-1)", () => {
  test("every load executor declares its name and probe channels", () => {
    for (const name of ["jest", "artillery-http", "raw-wasmer"]) {
      const executor = resolveExecutor(name);
      expect(executor.name).toBe(name);
      expect(executor.probeChannels.length).toBeGreaterThan(0);
    }
    // host-process exists, but only baselines and controls may reach it: a
    // scenario whose measured workload never touches Wasmer proves nothing.
    expect(findExecutor("host-process")).not.toBeNull();
    expect(() => resolveExecutor("host-process")).toThrow(PreflightError);
  });

  test("an unknown executor is a dispatch error naming the known set", () => {
    expect(() => resolveExecutor("artilery")).toThrow(
      /unknown executor "artilery"[\s\S]*jest, raw-wasmer/,
    );
  });

  test("a value that is not a RunOutcome is rejected at runtime, not passed on", () => {
    const good: RunOutcome = {
      startedAt: "a",
      finishedAt: "b",
      counters: {},
      logs: { stdout: "/tmp/x" },
    };
    expect(assertRunOutcome(good, "jest")).toBe(good);
    expect(() => assertRunOutcome({ startedAt: "a" }, "custom")).toThrow(
      /executor "custom" returned a value that is not a RunOutcome/,
    );
    expect(() =>
      assertRunOutcome({ ...good, counters: { n: "3" } }, "x"),
    ).toThrow(/counters/);
  });
});

describe("template interpolation (QA-638)", () => {
  test("interpolates values, keys and nested structures", () => {
    const profile = {
      target: "{{ victim.url }}",
      volumes: { "{{ probe.path }}": "/work" },
      flow: [{ get: { url: "{{ victim.url }}/a" } }],
    };
    expect(templateReferences(profile)).toEqual(["victim.url", "probe.path"]);
    expect(
      interpolate(
        profile,
        { "victim.url": "http://x", "probe.path": "/p" },
        "load",
      ),
    ).toEqual({
      target: "http://x",
      volumes: { "/p": "/work" },
      flow: [{ get: { url: "http://x/a" } }],
    });
  });

  test("an unresolved variable names the variable and what was available", () => {
    expect(() =>
      interpolate(
        { url: "{{ victim.url }}" },
        { "probe.path": "/p" },
        "load.jest",
      ),
    ).toThrow(TemplateError);
    expect(() =>
      interpolate(
        { url: "{{ victim.url }}" },
        { "probe.path": "/p" },
        "load.jest",
      ),
    ).toThrow(/load\.jest references \{\{ victim\.url \}\}[\s\S]*probe\.path/);
  });

  test("static reference checks catch typos before any fixture resolves", () => {
    const scenario = parseScenario(
      {
        meta: { id: "X", title: "t" },
        fixtures: {
          probes: { matrix: { source: "package:./probe" } },
          components: { python: "registry:python/python@=3.13.5" },
        },
        load: { "raw-wasmer": { package: "x" } },
      },
      "draft",
    );
    expect(checkReference(scenario, "matrix.path").problem).toBeNull();
    expect(checkReference(scenario, "component.python").problem).toBeNull();
    expect(checkReference(scenario, "matirx.path").problem).toMatch(
      /undeclared fixture "matirx"[\s\S]*declared fixtures: matrix/,
    );
    expect(checkReference(scenario, "matrix.pathh").problem).toMatch(
      /unknown affordance "pathh"/,
    );
    expect(checkReference(scenario, "component.pytohn").problem).toMatch(
      /undeclared component "pytohn"/,
    );
    // A deployed-app affordance is legal but needs a deployment.
    expect(checkReference(scenario, "matrix.url").needsDeployment).toBe(true);
  });
});

describe("raw-wasmer executor (QA-639, AC-3)", () => {
  test("builds the WAX-603 script's own invocation", () => {
    const profile = parseRawWasmerProfile({
      package: "python/python@3.13.5",
      volumes: { "/repo/probe": "/work" },
      args: ["/work/repro.py", "--once"],
    });
    expect(buildArgv(profile, "wasmer")).toEqual([
      "wasmer",
      "run",
      "python/python@3.13.5",
      "--volume",
      "/repo/probe:/work",
      "--",
      "/work/repro.py",
      "--once",
    ]);
  });

  test("the binary is caller-selected: profile, then WASMER_PATH, then PATH", () => {
    const bare = parseRawWasmerProfile({ package: "p" });
    expect(selectBinary(bare, {})).toBe("wasmer");
    expect(selectBinary(bare, { WASMER_PATH: "/opt/wasmer" })).toBe(
      "/opt/wasmer",
    );
    expect(
      selectBinary(
        parseRawWasmerProfile({ package: "p", binary: "/my/wasmer" }),
        {
          WASMER_PATH: "/opt/wasmer",
        },
      ),
    ).toBe("/my/wasmer");
  });

  test("a selected binary that does not exist is an actionable preflight error", async () => {
    const dir = scratch();
    await expect(
      executeRawWasmer(
        { package: "p", binary: "/nonexistent/wasmer" },
        stateIn(dir),
        { repoDir: dir, scenarioDir: dir },
      ),
    ).rejects.toThrow(
      /selected wasmer binary "\/nonexistent\/wasmer" does not exist/,
    );
    await expect(
      executeRawWasmer(
        { package: "p", binary: "/nonexistent/wasmer" },
        stateIn(dir),
        { repoDir: dir, scenarioDir: dir },
      ),
    ).rejects.toThrow(PreflightError);
  });

  test("interpolates the package from a resolved component", async () => {
    const dir = scratch();
    let seen: string[] = [];
    await executeRawWasmer(
      { package: "{{ component.python }}", args: ["--once"] },
      stateIn(dir, { "component.python": "python/python@3.13.5" }),
      {
        repoDir: dir,
        scenarioDir: dir,
        exec: async (argv, opts) => {
          seen = argv;
          writeFileSync(opts.stdoutFile, "");
          writeFileSync(opts.stderrFile, "");
          return { exitCode: 0, timedOut: false };
        },
      },
    );
    expect(seen).toEqual([
      "wasmer",
      "run",
      "python/python@3.13.5",
      "--",
      "--once",
    ]);
  });
});

describe("host-process executor (D8/D10)", () => {
  test("dispatches engine names to their host invocation conventions", () => {
    const argvFor = (profile: Record<string, unknown>): string[] =>
      buildEngineArgv(
        // parse through the schema so defaults and refinements apply
        JSON.parse(JSON.stringify(profile)) as never,
      );
    expect(
      argvFor({ engine: "python3", entry: ["repro.py", "--once"] }),
    ).toEqual(["python3", "repro.py", "--once"]);
    expect(argvFor({ engine: "node", entry: ["repro.mjs"] })).toEqual([
      "node",
      "repro.mjs",
    ]);
    expect(argvFor({ engine: "go", entry: ["./main.go"] })).toEqual([
      "go",
      "run",
      "./main.go",
    ]);
    expect(argvFor({ engine: "cargo", entry: ["--bin", "repro"] })).toEqual([
      "cargo",
      "run",
      "--quiet",
      "--bin",
      "repro",
    ]);
    expect(
      argvFor({ engine: "binary", command: ["/usr/bin/env"], entry: ["true"] }),
    ).toEqual(["/usr/bin/env", "true"]);
  });

  test("really runs a host interpreter and captures its marker line", async () => {
    const dir = scratch();
    writeFileSync(
      path.join(dir, "probe.py"),
      'import sys\nprint("ASS-VERDICT: not-reproduced all ok", file=sys.stderr)\n',
    );
    const outcome = await executeHostProcess(
      { engine: "python3", entry: ["probe.py"] },
      stateIn(path.join(dir, "artifacts")),
      { repoDir: dir, scenarioDir: dir, label: "baseline" },
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.command).toEqual(["python3", "probe.py"]);
    expect(readFileSync(outcome.logs["stderr"], "utf8")).toContain(
      "ASS-VERDICT: not-reproduced",
    );
    expect(
      evaluateProbe(
        [
          {
            channel: { type: "log", stream: "stderr" },
            source: "process-capture",
          },
        ],
        outcome,
      ).outcome,
    ).toBe("not-reproduced");
  });

  test("a nonzero child exit is captured, not thrown", async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "boom.py"), "raise SystemExit(3)\n");
    const outcome = await executeHostProcess(
      { engine: "python3", entry: ["boom.py"] },
      stateIn(path.join(dir, "artifacts")),
      { repoDir: dir, scenarioDir: dir },
    );
    expect(outcome.exitCode).toBe(3);
    expect(outcome.logs["stderr"]).toContain("host-process.stderr.log");
  });

  test("the backstop timeout kills a hanging child and marks the outcome", async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "hang.py"), "import time\ntime.sleep(60)\n");
    const outcome = await executeHostProcess(
      { engine: "python3", entry: ["hang.py"], timeoutSeconds: 1 },
      stateIn(path.join(dir, "artifacts")),
      { repoDir: dir, scenarioDir: dir },
    );
    expect(outcome.timedOut).toBe(true);
    // A killed probe never reads as health, whatever it managed to print.
    expect(
      evaluateProbe(
        [
          {
            channel: { type: "log", stream: "stderr" },
            source: "process-capture",
          },
        ],
        outcome,
      ).outcome,
    ).toBe("inconclusive");
  }, 20000);
});

describe("the ASS-VERDICT probe contract (D11)", () => {
  const outcomeWith = (
    stderr: string,
    extra: Partial<RunOutcome> = {},
  ): RunOutcome => {
    const dir = scratch();
    const file = path.join(dir, "workload.stderr.log");
    writeFileSync(file, stderr);
    return {
      startedAt: "a",
      finishedAt: "b",
      counters: {},
      logs: { stderr: file },
      exitCode: 0,
      ...extra,
    };
  };

  test("parses the grammar: token plus free-text detail", () => {
    const reading = readMarkers(
      ["noise", "ASS-VERDICT: reproduced 4 primitive(s) broken", "more"],
      "log:stderr",
    );
    expect(reading.tokens).toEqual(["reproduced"]);
    expect(reading.detail).toBe("4 primitive(s) broken");
  });

  test("no line at all is inconclusive, never not-reproduced", () => {
    const verdict = evaluateProbe(
      [
        {
          channel: { type: "log", stream: "stderr" },
          source: "process-capture",
        },
      ],
      outcomeWith("the probe said nothing useful\n"),
    );
    expect(verdict.outcome).toBe("inconclusive");
    expect(verdict.reason).toMatch(/emitted no ASS-VERDICT: line/);
  });

  test("repeated identical lines are one logical verdict", () => {
    expect(
      evaluateProbe(
        [
          {
            channel: { type: "log", stream: "stderr" },
            source: "process-capture",
          },
        ],
        outcomeWith("ASS-VERDICT: reproduced x\nASS-VERDICT: reproduced x\n"),
      ).outcome,
    ).toBe("reproduced");
  });

  test("conflicting outcomes are inconclusive, naming both", () => {
    const verdict = evaluateProbe(
      [
        {
          channel: { type: "log", stream: "stderr" },
          source: "process-capture",
        },
      ],
      outcomeWith("ASS-VERDICT: reproduced a\nASS-VERDICT: not-reproduced b\n"),
    );
    expect(verdict.outcome).toBe("inconclusive");
    expect(verdict.reason).toMatch(/conflicting.*reproduced, not-reproduced/);
  });

  test("an unrecognized outcome token is inconclusive", () => {
    expect(
      evaluateProbe(
        [
          {
            channel: { type: "log", stream: "stderr" },
            source: "process-capture",
          },
        ],
        outcomeWith("ASS-VERDICT: probably-fine\n"),
      ).reason,
    ).toMatch(/unrecognized outcome token\(s\) probably-fine/);
  });

  test("a healthy verdict from a process that died is a named contradiction", () => {
    const nonzero = evaluateProbe(
      [
        {
          channel: { type: "log", stream: "stderr" },
          source: "process-capture",
        },
      ],
      outcomeWith("ASS-VERDICT: not-reproduced all ok\n", { exitCode: 1 }),
    );
    expect(nonzero.outcome).toBe("inconclusive");
    expect(nonzero.reason).toMatch(/exited 1[\s\S]*contradict/);

    const signalled = evaluateProbe(
      [
        {
          channel: { type: "log", stream: "stderr" },
          source: "process-capture",
        },
      ],
      outcomeWith("ASS-VERDICT: not-reproduced all ok\n", {
        exitCode: 137,
        signal: "SIGKILL",
      }),
    );
    expect(signalled.reason).toMatch(/died by signal SIGKILL/);

    // A *reproduced* verdict from a dead process is not a contradiction: a
    // repro that crashes the process is exactly the thing being reproduced.
    expect(
      evaluateProbe(
        [
          {
            channel: { type: "log", stream: "stderr" },
            source: "process-capture",
          },
        ],
        outcomeWith("ASS-VERDICT: reproduced it panicked\n", { exitCode: 101 }),
      ).outcome,
    ).toBe("reproduced");
  });

  test("an unreadable channel is not a silent probe", () => {
    const verdict = evaluateProbe(
      [{ channel: { type: "http", match: "body" }, source: "http-fetch" }],
      outcomeWith(""),
    );
    expect(verdict.outcome).toBe("inconclusive");
    expect(verdict.reason).toMatch(/no declared probe channel could be read/);
  });
});

describe("artillery-http executor (QA-638)", () => {
  test("passes an Artillery-native block through, adding per-endpoint metrics", () => {
    const profile = parseArtilleryProfile({
      target: "http://victim.localhost",
      phases: [{ duration: 30, arrivalRate: 100 }],
      ensure: { maxErrorRate: 1 },
      scenarios: [{ flow: [{ get: { url: "/a" } }] }],
    });
    expect(buildArtilleryScript(profile)).toEqual({
      config: {
        target: "http://victim.localhost",
        phases: [{ duration: 30, arrivalRate: 100 }],
        ensure: { maxErrorRate: 1 },
        // A declared ensure: only runs if its plugin is listed, so the
        // executor lists it rather than reporting a green load test that
        // never checked a threshold.
        plugins: { "metrics-by-endpoint": {}, ensure: {} },
      },
      scenarios: [{ flow: [{ get: { url: "/a" } }] }],
    });
  });

  test("a native config: block is used verbatim", () => {
    const profile = parseArtilleryProfile({
      config: {
        target: "http://x",
        phases: [{ duration: 1, arrivalCount: 1 }],
      },
      scenarios: [{ flow: [{ get: { url: "/" } }] }],
    });
    expect(buildArtilleryScript(profile).config).toEqual({
      target: "http://x",
      phases: [{ duration: 1, arrivalCount: 1 }],
    });
  });

  test("mixing the two spellings is a profile error, not a silent winner", () => {
    expect(() =>
      parseArtilleryProfile({
        config: { target: "http://x" },
        target: "http://y",
        scenarios: [{ flow: [] }],
      }),
    ).toThrow(/not both[\s\S]*config: plus target/);
  });

  test("a profile with no target at all is rejected before the run", () => {
    expect(() => parseArtilleryProfile({ scenarios: [{ flow: [] }] })).toThrow(
      /needs a target:/,
    );
  });
});

// -- end-to-end through the CLI, without booting a platform -----------------
// A raw-wasmer scenario declares no platform components, apps or
// perturbations, so these exercise the whole run path in milliseconds.

const PROBE_SCENARIO = `
[meta]
id = "PB-1"
title = "a self-verdicting probe"
lifecycle = { state = "open" }

[fixtures.probes.matrix]
source = "package:./probe"
executors = ["raw-wasmer"]

[fixtures.components]
python = "registry:python/python@=3.13.5"

[load]
executor = "raw-wasmer"

[load.raw-wasmer]
package = "{{ component.python }}"
args = ["/work/repro.py", "--once"]

[load.raw-wasmer.volumes]
"{{ matrix.path }}" = "/work"

[verdict.probe]
channels = [{ type = "log", stream = "stderr" }]

[verdict.baseline]
engine = "python3"
entry = ["repro.py", "--once"]
workdir = "{{ matrix.path }}"
expect = "not-reproduced"
`;

function probeRoot(toml = PROBE_SCENARIO): string {
  const root = makeRoot();
  const dir = addScenario(root, "repros", "probey", toml);
  mkdirSync(path.join(dir, "probe"), { recursive: true });
  writeFileSync(path.join(dir, "probe", "repro.py"), "print('hi')\n");
  return root;
}

describe("probe scenarios end to end", () => {
  test("a reproducing probe with a clean baseline is expected, exit 0 (AC-4 shape)", async () => {
    const harness = makeFakeHarness();
    harness.deps.workloadExec = scriptedExec([
      { match: /wasmer run/, stderr: "ASS-VERDICT: reproduced 5 broken\n" },
      {
        match: /python3 repro\.py/,
        stderr: "ASS-VERDICT: not-reproduced ok\n",
      },
    ]);
    harness.deps.enginePresence = () => true;
    const result = await cli(probeRoot(), ["run", "probey"], harness.deps);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("reproduced");
    expect(result.stdout).toContain("repro intact on the pinned versions");
    // No stack was booted for a `wasmer run` workload.
    expect(harness.calls).toEqual([]);
  });

  test("a violated baseline is inconclusive with the violation named", async () => {
    const harness = makeFakeHarness();
    harness.deps.workloadExec = scriptedExec([
      { match: /wasmer run/, stderr: "ASS-VERDICT: reproduced 5 broken\n" },
      // The bug exists natively too: the reproduction claim does not stand.
      {
        match: /python3 repro\.py/,
        stderr: "ASS-VERDICT: reproduced 5 broken\n",
      },
    ]);
    harness.deps.enginePresence = () => true;
    const result = await cli(probeRoot(), ["run", "probey"], harness.deps);
    expect(result.code).toBe(3);
    expect(result.stdout).toContain("inconclusive");
    expect(result.stdout).toContain(
      'baseline "baseline" expected not-reproduced but observed reproduced',
    );
  });

  test("a missing baseline engine degrades the run visibly and blocks promotion", async () => {
    const harness = makeFakeHarness();
    harness.deps.workloadExec = scriptedExec([
      { match: /wasmer run/, stderr: "ASS-VERDICT: reproduced 5 broken\n" },
    ]);
    harness.deps.enginePresence = () => false;
    const root = probeRoot();
    const result = await cli(root, ["run", "probey"], harness.deps);
    // The main load still ran and still reproduced: a missing engine costs
    // the differential, not the run.
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("baseline not exercised");
    expect(result.stdout).toContain("engine-missing");
  });

  test("a silent probe is inconclusive, and the captured output is retained", async () => {
    const harness = makeFakeHarness();
    harness.deps.workloadExec = scriptedExec([
      {
        match: /wasmer run/,
        stdout: "matrix ran\n",
        stderr: "nothing to say\n",
      },
      {
        match: /python3 repro\.py/,
        stderr: "ASS-VERDICT: not-reproduced ok\n",
      },
    ]);
    harness.deps.enginePresence = () => true;
    const result = await cli(probeRoot(), ["run", "probey"], harness.deps);
    expect(result.code).toBe(3);
    expect(result.stdout).toMatch(/emitted no ASS-VERDICT: line/);
    const report = JSON.parse(
      readFileSync(
        path.join(result.stdout.match(/report │ (\S+report\.json)/)?.[1] ?? ""),
        "utf8",
      ),
    );
    expect(readFileSync(report.workload.logs.stdout, "utf8")).toBe(
      "matrix ran\n",
    );
  });

  test("the backstop timeout is inconclusive, never not-reproduced", async () => {
    const harness = makeFakeHarness();
    harness.deps.workloadExec = scriptedExec([
      { match: /wasmer run/, stderr: "", timedOut: true, exitCode: 137 },
      {
        match: /python3 repro\.py/,
        stderr: "ASS-VERDICT: not-reproduced ok\n",
      },
    ]);
    harness.deps.enginePresence = () => true;
    const result = await cli(probeRoot(), ["run", "probey"], harness.deps);
    expect(result.code).toBe(3);
    expect(result.stdout).toMatch(/backstop timeout killed the probe/);
  });
});

describe("declared controls (D8)", () => {
  // A second guest engine version, run through a declared load profile: the
  // exotic comparison the baseline is the distinguished member of.
  // A profile is named after its executor unless it names one, which is the
  // only way to declare two raw-wasmer profiles in one scenario.
  const WITH_CONTROL = PROBE_SCENARIO.replace(
    "[verdict.probe]",
    `[load.old-interpreter]
executor = "raw-wasmer"
package = "python/python@3.12.0"
args = ["--once"]

[verdict.controls.old-interpreter]
executor = "old-interpreter"
expect = "reproduced"

[verdict.probe]`,
  );

  test("a control that behaves as declared leaves the outcome alone", async () => {
    const harness = makeFakeHarness();
    harness.deps.workloadExec = scriptedExec([
      {
        match: /python@3\.12\.0/,
        stderr: "ASS-VERDICT: reproduced also broken\n",
      },
      { match: /wasmer run/, stderr: "ASS-VERDICT: reproduced 5 broken\n" },
      {
        match: /python3 repro\.py/,
        stderr: "ASS-VERDICT: not-reproduced ok\n",
      },
    ]);
    harness.deps.enginePresence = () => true;
    const result = await cli(
      probeRoot(WITH_CONTROL),
      ["run", "probey"],
      harness.deps,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("reproduced");
    expect(result.stdout).toContain("old-interpreter");
  });

  test("a control that violates its expectation makes the run inconclusive", async () => {
    const harness = makeFakeHarness();
    harness.deps.workloadExec = scriptedExec([
      // The older interpreter was supposed to be broken too, and is not:
      // whatever the workload showed, the story does not hold together.
      {
        match: /python@3\.12\.0/,
        stderr: "ASS-VERDICT: not-reproduced fine\n",
      },
      { match: /wasmer run/, stderr: "ASS-VERDICT: reproduced 5 broken\n" },
      {
        match: /python3 repro\.py/,
        stderr: "ASS-VERDICT: not-reproduced ok\n",
      },
    ]);
    harness.deps.enginePresence = () => true;
    const result = await cli(
      probeRoot(WITH_CONTROL),
      ["run", "probey"],
      harness.deps,
    );
    expect(result.code).toBe(3);
    expect(result.stdout).toContain(
      'control "old-interpreter" expected reproduced but observed not-reproduced',
    );
  });

  test("a native control dispatches to its engine like a baseline", async () => {
    const harness = makeFakeHarness();
    const seen: string[] = [];
    harness.deps.workloadExec = async (argv, opts) => {
      seen.push(argv.join(" "));
      writeFileSync(opts.stdoutFile, "");
      writeFileSync(
        opts.stderrFile,
        argv[0] === "wasmer"
          ? "ASS-VERDICT: reproduced 5 broken\n"
          : "ASS-VERDICT: not-reproduced native engines are fine\n",
      );
      return { exitCode: 0, timedOut: false };
    };
    harness.deps.enginePresence = () => true;
    const root = probeRoot(
      PROBE_SCENARIO.replace(
        "[verdict.baseline]",
        `[verdict.controls.node-too]
engine = "node"
entry = ["probe.mjs"]
expect = "not-reproduced"

[verdict.baseline]`,
      ),
    );
    const result = await cli(root, ["run", "probey"], harness.deps);
    expect(result.code).toBe(0);
    expect(seen).toContain("node probe.mjs");
  });
});

describe("preflight before any workload runs (AC-5)", () => {
  test("a fixture that excludes the active executor fails preflight", async () => {
    const root = probeRoot(
      PROBE_SCENARIO.replace(
        'executors = ["raw-wasmer"]',
        'executors = ["artillery-http"]',
      ).replace(
        '[load]\nexecutor = "raw-wasmer"',
        '[load]\nexecutor = "raw-wasmer"\n\n[load.artillery-http]\n' +
          'target = "http://x"\nscenarios = [{ flow = [] }]',
      ),
    );
    const harness = makeFakeHarness();
    const result = await cli(root, ["run", "probey"], harness.deps);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('fixture "matrix" declares executors');
    expect(result.stdout).toContain("no fixtures were resolved");
    expect(harness.calls).toEqual([]);
  });

  test("an unresolvable template variable fails preflight naming it", async () => {
    const root = probeRoot(
      PROBE_SCENARIO.replace("{{ matrix.path }}", "{{ matirx.path }}"),
    );
    const result = await cli(root, ["run", "probey"], makeFakeHarness().deps);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("{{ matirx.path }}");
    expect(result.stdout).toContain('undeclared fixture "matirx"');
  });

  test("a probe channel no executor can carry fails preflight", async () => {
    const root = probeRoot(
      PROBE_SCENARIO.replace(
        'channels = [{ type = "log", stream = "stderr" }]',
        'channels = [{ type = "http", match = "body" }]',
      ),
    );
    const result = await cli(root, ["run", "probey"], makeFakeHarness().deps);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("http:body");
    expect(result.stdout).toContain("need a remote target");
  });

  test("a baseline no executor-observable evidence can judge fails preflight", async () => {
    const root = makeRoot();
    addScenario(
      root,
      "repros",
      "unjudgeable",
      `
[meta]
id = "UJ-1"
title = "environment-only verdict with a native baseline"
lifecycle = { state = "open" }

[fixtures.components]
edge = "github-release:wasmerio/edge:v1:edge"

[load]
executor = "jest"

[load.jest]
spec = "tests/x.test.ts"

[[verdict.reproduced_when.any]]
log_matches = { stream = "edge", pattern = "boom" }

[verdict.baseline]
engine = "python3"
entry = ["repro.py"]
`,
    );
    const result = await cli(
      root,
      ["run", "unjudgeable"],
      makeFakeHarness().deps,
    );
    expect(result.code).toBe(1);
    // The presenter wraps, so assert on fragments rather than the sentence.
    expect(result.stdout).toContain("the native baseline is a host process");
    expect(result.stdout).toContain("waive the baseline with a reason");
  });
});

describe("the wax-603 reference declaration", () => {
  test("parses under persisted validation with the shape Phase 4 specifies", async () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const { loadScenario, rootsFrom } =
      await import("../../ass/scenario/loader");
    const scenario = loadScenario(
      rootsFrom(repoRoot),
      "repro",
      "wax-603",
    ).scenario;

    expect(scenario.fixtures.components).toEqual({
      python: "registry:python/python@=3.13.5",
    });
    expect(scenario.fixtures.probes?.["matrix"]).toEqual({
      source: "package:./probe",
      executors: ["raw-wasmer", "artillery-http"],
    });
    // Two profiles declared, exactly one active (D8).
    expect(scenario.load.activeExecutor).toBe("raw-wasmer");
    expect(Object.keys(scenario.load.profiles).sort()).toEqual([
      "artillery-http",
      "raw-wasmer",
    ]);
    expect(scenario.verdict?.probe?.channels).toEqual([
      { type: "log", stream: "stderr" },
      { type: "http", match: "body" },
    ]);
    expect(scenario.verdict?.baseline).toEqual({
      engine: "python3",
      entry: ["repro.py", "--once"],
      workdir: "{{ matrix.path }}",
      expect: "not-reproduced",
    });
  });

  test("the probe emits exactly one ASS-VERDICT outcome on the declared channel", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const source = readFileSync(
      path.join(repoRoot, "repros", "wax-603", "probe", "repro.py"),
      "utf8",
    );
    expect(source).toContain("ASS-VERDICT: reproduced");
    expect(source).toContain("ASS-VERDICT: not-reproduced");
    expect(source).toContain("file=sys.stderr");
  });
});
