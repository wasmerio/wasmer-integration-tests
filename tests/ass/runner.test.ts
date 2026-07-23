// Executor-boundary and run-orchestration tests (Phase 2): the jest profile
// contract, setup-precedes-workload ordering, the four distinct outcomes and
// their D15 exit codes through the real CLI, remote perturbation warnings,
// Phase-4 capability gates, and cleanup on workload failure.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  executeJest,
  parseJestProfile,
  ExecutorProfileError,
} from "../../ass/executors/jest";
import type { ResolvedState } from "../../ass/executors/contract";
import {
  addScenario,
  cli,
  makeFakeHarness,
  makeRoot,
  PERSISTED_YAML,
} from "./helpers";

describe("jest executor boundary", () => {
  test("profile schema rejects unknown keys and missing spec", () => {
    expect(() => parseJestProfile({})).toThrow(ExecutorProfileError);
    expect(() => parseJestProfile({ spec: "x", frobnicate: true })).toThrow(
      /frobnicate/,
    );
  });

  test("runs jest with the resolved env and captures both streams", async () => {
    const harness = makeFakeHarness({
      workload: { code: 1, stdout: "1 failed\n", stderr: "worker died\n" },
    });
    await harness.deps.driver!.up();
    const state: ResolvedState = {
      env: "local",
      variables: {},
      components: {},
      pins: {},
      execEnv: { WASMER_REGISTRY: "http://localhost:1/graphql" },
      artifactsDir: path.join(harness.runDir, "ass"),
      composeLogPath: null,
      cleanup: async () => [],
    };
    let seenEnv: NodeJS.ProcessEnv = {};
    const outcome = await executeJest(
      { spec: "tests/app/templates.test.ts", testNamePattern: "next-react" },
      state,
      {
        repoDir: "/repo",
        scenarioDir: "/repo/repros/wax-600",
        exec: async (argv, opts) => {
          seenEnv = opts.env;
          expect(argv).toEqual([
            "pnpm",
            "exec",
            "jest",
            "tests/app/templates.test.ts",
            "-t",
            "next-react",
          ]);
          expect(opts.cwd).toBe("/repo");
          const { writeFileSync } = await import("node:fs");
          writeFileSync(opts.stdoutFile, "1 failed\n");
          writeFileSync(opts.stderrFile, "worker died\n");
          return { exitCode: 1, timedOut: false };
        },
      },
    );
    expect(seenEnv["WASMER_REGISTRY"]).toBe("http://localhost:1/graphql");
    // The workload's own failure is recorded, never thrown: the verdict
    // decides the outcome (a reproduced panic usually fails the test too).
    expect(outcome.exitCode).toBe(1);
    expect(readFileSync(outcome.logs["stdout"], "utf8")).toBe("1 failed\n");
    expect(readFileSync(outcome.logs["stderr"], "utf8")).toBe("worker died\n");
  });
});

describe("run orchestration through the CLI", () => {
  function makeRepoRoot(): string {
    const root = makeRoot();
    addScenario(root, "repros", "wax-600", PERSISTED_YAML);
    return root;
  }

  test("setup completes before the workload starts; cleanup always runs", async () => {
    const harness = makeFakeHarness();
    const result = await cli(makeRepoRoot(), ["run", "wax-600"], harness.deps);

    expect(result.code).toBe(0);
    const execIndex = harness.calls.findIndex((call) =>
      call.startsWith("exec:"),
    );
    const upIndex = harness.calls.indexOf("up");
    const deployIndex = harness.calls.indexOf("deploy:victim");
    expect(upIndex).toBeGreaterThanOrEqual(0);
    expect(deployIndex).toBeGreaterThan(upIndex);
    expect(execIndex).toBeGreaterThan(deployIndex);
    expect(harness.calls.slice(execIndex + 1)).toEqual(["down", "restore"]);
  });

  test("a reproduced pinned open run exits 0 with retained evidence", async () => {
    const root = makeRepoRoot();
    const harness = makeFakeHarness({
      composeLog:
        "edge-1  | thread 'tokio-runtime-worker' panicked at lib.rs:9:\n" +
        "edge-1  | object used with the wrong context\n" +
        "edge-1  | note: run with RUST_BACKTRACE=1\n",
    });
    const result = await cli(root, ["run", "wax-600"], harness.deps);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("reproduced");
    expect(result.stdout).toContain("repro intact on the pinned versions");

    const report = JSON.parse(
      readFileSync(path.join(harness.runDir, "ass", "report.json"), "utf8"),
    );
    expect(report.outcome).toBe("reproduced");
    expect(report.assessment.exitCode).toBe(0);
    expect(report.components).toEqual({
      edge: "github-release:wasmerio/edge:v2026-08-05_1_419b336_dev1:edge",
      backend: "stackmachine:v2026-08-03_1_c3252ee",
    });
    expect(report.workload.exitCode).toBe(1);
  });

  test("a quiet run on pinned open versions is repro rot: alert, exit 2", async () => {
    const root = makeRepoRoot();
    const harness = makeFakeHarness({
      composeLog: "edge-1  | all healthy\n",
      workload: { code: 0, stdout: "1 passed\n", stderr: "" },
    });
    const result = await cli(root, ["run", "wax-600"], harness.deps);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("not-reproduced");
    expect(result.stdout).toContain("repro rot");
    // Workload failure/cleanup contract: teardown ran even though the
    // assessment alerts.
    expect(harness.calls.slice(-2)).toEqual(["down", "restore"]);
  });

  test("a failed boot is setup-failed: exit 4 and a persisted report", async () => {
    const root = makeRepoRoot();
    const harness = makeFakeHarness({ failUp: "no such release asset" });
    const result = await cli(root, ["run", "wax-600"], harness.deps);
    expect(result.code).toBe(4);
    expect(result.stdout).toContain("setup-failed");
    expect(result.stdout).toContain("no such release asset");
    // No workload ran, cleanup did.
    expect(harness.calls.some((call) => call.startsWith("exec:"))).toBe(false);
    expect(harness.calls.slice(-2)).toEqual(["down", "restore"]);

    const reportsDir = path.join(root, ".local-platform", "ass");
    const reports = readdirSync(reportsDir);
    expect(reports).toHaveLength(1);
    const report = JSON.parse(
      readFileSync(path.join(reportsDir, reports[0]), "utf8"),
    );
    expect(report.outcome).toBe("setup-failed");
    expect(report.setupFailure).toContain("no such release asset");
  });

  test("an interrupt mid-boot restores mutated files and exits 130", async () => {
    const root = makeRepoRoot();
    let fire: ((signal: NodeJS.Signals) => void) | undefined;
    let disarmed = false;
    const exits: number[] = [];
    // Ctrl-C reaches the whole process group, so the platform child dies too
    // and `up` fails — the same shape as a real interrupted boot.
    const harness = makeFakeHarness({
      onUp: () => fire?.("SIGINT"),
      failUp: "local platform up failed with status 130",
    });
    const result = await cli(root, ["run", "wax-600"], {
      ...harness.deps,
      signals: {
        arm: (handler) => {
          fire = handler;
        },
        disarm: () => {
          disarmed = true;
        },
      },
      // The fake exit does not terminate, so the run continues into its
      // normal failure path; the assertion is that 130 was requested.
      exit: (code) => exits.push(code),
    });
    expect(exits).toEqual([130]);
    // Restoration happened at interrupt time, not only in the later cleanup.
    expect(harness.calls[harness.calls.indexOf("up") + 1]).toBe("restore");
    expect(harness.calls.some((call) => call.startsWith("exec:"))).toBe(false);
    expect(result.stdout).toContain("interrupted by SIGINT");
    expect(disarmed).toBe(true);
  });

  test("cleanup errors surface in the run output without changing the outcome", async () => {
    const root = makeRepoRoot();
    const harness = makeFakeHarness({ failDown: "compose down timed out" });
    const result = await cli(root, ["run", "wax-600"], harness.deps);
    expect(result.code).toBe(0); // reproduced (default fake panic log)
    // The whole run renders as one table on one stream: splitting progress
    // onto stderr would tear it in half under redirection.
    expect(result.stdout).toContain("cleanup error: compose down timed out");
    const report = JSON.parse(
      readFileSync(path.join(harness.runDir, "ass", "report.json"), "utf8"),
    );
    expect(report.cleanupErrors).toEqual(["compose down timed out"]);
  });

  test("a workload that fails to execute is setup-failed with a report (R3-02)", async () => {
    const root = makeRepoRoot();
    const harness = makeFakeHarness();
    harness.deps.workloadExec = async () => {
      throw new Error("failed to spawn workload pnpm: ENOENT");
    };
    const result = await cli(root, ["run", "wax-600"], harness.deps);
    expect(result.code).toBe(4);
    expect(result.stdout).toContain("setup-failed");
    expect(result.stdout).toContain("ENOENT");
    // Cleanup ran; the failure is a reported D15 exit, not an internal fault.
    expect(harness.calls.slice(-2)).toEqual(["down", "restore"]);
    const report = JSON.parse(
      readFileSync(path.join(harness.runDir, "ass", "report.json"), "utf8"),
    );
    expect(report.outcome).toBe("setup-failed");
    expect(report.setupFailure).toContain("failed to execute");
    expect(report.workload).toBeNull();
  });

  test("the report accounts for setup, workload, and cleanup wall clock", async () => {
    const root = makeRepoRoot();
    const harness = makeFakeHarness();
    let clock = 1_000_000;
    // Each phase boundary advances the fake clock by a distinct amount.
    harness.deps.now = () => (clock += 10_000);
    const result = await cli(root, ["run", "wax-600"], harness.deps);
    expect(result.code).toBe(0);

    const report = JSON.parse(
      readFileSync(path.join(harness.runDir, "ass", "report.json"), "utf8"),
    );
    expect(report.timing.phases.map((p: { name: string }) => p.name)).toEqual([
      "setup",
      "workload",
      "cleanup",
    ]);
    for (const phase of report.timing.phases) {
      expect(phase.seconds).toBeGreaterThan(0);
      expect(Date.parse(phase.startedAt)).toBeLessThan(
        Date.parse(phase.finishedAt),
      );
    }
    expect(report.timing.seconds).toBeGreaterThanOrEqual(
      report.timing.phases.reduce(
        (sum: number, p: { seconds: number }) => sum + p.seconds,
        0,
      ),
    );
    expect(result.stdout).toMatch(/timing │ total: /);
    // The verdict is announced before teardown, not after.
    expect(result.stdout).toMatch(/cleanup │ verdict reproduced; tearing down/);
  });

  test("a timed-out workload is marked in the report and summary (R3-05)", async () => {
    const root = makeRepoRoot();
    const harness = makeFakeHarness({
      workload: { code: 137, stdout: "", stderr: "", timedOut: true },
    });
    const result = await cli(root, ["run", "wax-600"], harness.deps);
    expect(result.code).toBe(0); // default fake panic log: reproduced
    expect(result.stdout).toContain("hit the executor timeout");
    const report = JSON.parse(
      readFileSync(path.join(harness.runDir, "ass", "report.json"), "utf8"),
    );
    expect(report.workload.timedOut).toBe(true);
  });

  test("--cpus overrides the declared cap; without one it is an error", async () => {
    const root = makeRepoRoot();
    const harness = makeFakeHarness();
    const ok = await cli(root, ["run", "wax-600", "--cpus", "3"], harness.deps);
    expect(ok.code).toBe(0);
    expect(harness.calls).toContain("cpus:edge=3");

    const noCap = makeRoot();
    addScenario(
      noCap,
      "repros",
      "quiet",
      PERSISTED_YAML.replace(/^ {2}perturbations:\n^ {4}edge: .*\n/m, ""),
    );
    const err = await cli(
      noCap,
      ["run", "quiet", "--cpus", "1"],
      makeFakeHarness().deps,
    );
    expect(err.code).toBe(1);
    expect(err.stdout).toContain("declares none");
  });

  test("remote targets warn about perturbations and run without the local stack", async () => {
    // A remote-evaluable verdict (output_matches) so the evaluability
    // preflight passes; the run proceeds against the fake remote platform.
    const root = makeRoot();
    addScenario(
      root,
      "repros",
      "remote-ready",
      `
meta:
  id: RR-1
  title: remote-evaluable scenario
  lifecycle: { state: open }
fixtures:
  components:
    edge: github-release:wasmerio/edge:v1:edge
  perturbations:
    edge: { cpus: 1 }
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
`,
    );
    const harness = makeFakeHarness({
      workload: { code: 1, stdout: "kaboom\n", stderr: "" },
    });
    const result = await cli(
      root,
      ["run", "remote-ready", "--env", "dev"],
      harness.deps,
    );
    expect(result.code).toBe(0);
    // The warning lands inside the run's table; the run then proceeds
    // against the remote target (Phase 5) instead of refusing.
    expect(result.stdout).toContain("perturbations are ignored on remote");
    // Platform components cannot be pinned remotely: the run floats and
    // says so, and the local stack is never booted or mutated.
    expect(result.stdout).toContain("mode: floating");
    expect(result.stdout).toContain("cannot be pinned");
    expect(harness.calls).not.toContain("up");
    expect(harness.calls).not.toContain("down");
    expect(harness.calls.some((c) => c.startsWith("exec:"))).toBe(true);
    expect(harness.calls).toContain("remote-platform:dev");
  });

  test("deployed-app log streams fail preflight on local (QA-640 follow-up)", async () => {
    const root = makeRoot();
    addScenario(
      root,
      "repros",
      "appstream",
      `
meta:
  id: PR-1
  title: reads a deployed app's own log stream
  lifecycle: { state: open }
load:
  executor: jest
  jest:
    spec: tests/x.test.ts
verdict:
  reproduced_when:
    any:
      - log_matches: { stream: app, pattern: boom }
  baseline:
    waived: n/a
`,
    );
    const result = await cli(
      root,
      ["run", "appstream"],
      makeFakeHarness().deps,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Vector→Loki");
    expect(result.stdout).toContain("QA-640");
    expect(result.stdout).toContain("remote targets");
  });
});

describe("reference scenario declaration", () => {
  test("repros/wax-600 parses under persisted validation with the script's pins", async () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    expect(
      existsSync(path.join(repoRoot, "repros", "wax-600", "scenario.yaml")),
    ).toBe(true);
    const { loadScenario, rootsFrom } =
      await import("../../ass/scenario/loader");
    const loaded = loadScenario(rootsFrom(repoRoot), "repro", "wax-600");
    const scenario = loaded.scenario;
    expect(scenario.meta.lifecycle).toEqual({ state: "open" });
    expect(scenario.fixtures.components).toEqual({
      edge: "github-release:wasmerio/edge:v2026-07-16_1_fcdd9c4_dev1:edge",
      backend:
        "github-release:wasmerio/backend:v2026-07-15_2_9a6c3d4:*image*.tar*",
    });
    expect(scenario.fixtures.perturbations).toEqual({
      edge: { cpus: 1, wipe_caches: ["compiler_cache", "webc_cache"] },
    });
    expect(scenario.load.activeExecutor).toBe("jest");
    expect(scenario.load.profiles["jest"]).toEqual({
      spec: "tests/app/templates.test.ts",
      testNamePattern: "next-react-server-components",
    });
    expect(scenario.verdict?.reproduced_when).toEqual({
      any: [
        {
          log_matches: {
            stream: "edge",
            pattern: "object used with the wrong context",
          },
        },
      ],
    });
    expect(scenario.verdict?.collect).toEqual([
      {
        edge_panic_context: {
          stream: "edge",
          pattern: "panicked at",
          before: 1,
          after: 4,
        },
      },
    ]);
  });
});
