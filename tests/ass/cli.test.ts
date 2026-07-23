// Boundary tests for the ass CLI (Phase 1): command-to-loader selection
// (try -> experiments/ only, run -> repros/ only, list -> the union), the
// shared D12 override surface, and the guarantee that Phase 1 commands never
// mutate scenario directories or launch workloads.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  addScenario,
  cli,
  DRAFT_YAML,
  makeFakeHarness,
  makeRoot,
  PERSISTED_YAML,
  snapshotTree,
} from "./helpers";

function makePopulatedRoot(): string {
  const root = makeRoot();
  addScenario(root, "experiments", "exp-1", DRAFT_YAML);
  addScenario(root, "repros", "wax-600", PERSISTED_YAML);
  return root;
}

describe("ass list", () => {
  test("prints the union with experimental entries marked", async () => {
    const root = makePopulatedRoot();
    const result = await cli(root, ["list"]);
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n")).toEqual([
      "exp-1  (experimental)",
      "wax-600",
    ]);
  });
});

describe("command-to-loader boundary selection", () => {
  test("try runs drafts from experiments/ only", async () => {
    const root = makePopulatedRoot();
    const ok = await cli(root, ["try", "exp-1"], makeFakeHarness().deps);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("EXP-1");
    expect(ok.stdout).toContain("kind: draft");
    // The draft declares no verdict, so the run proves nothing and says so —
    // without alerting, because drafts carry no regression contract.
    expect(ok.stdout).toContain("declares no verdict");

    const cross = await cli(root, ["try", "wax-600"]);
    expect(cross.code).toBe(1);
    expect(cross.stderr).toContain(
      'scenario "wax-600" not found in experiments/',
    );
  });

  test("run loads persisted scenarios from repros/ only, case-insensitively", async () => {
    const root = makePopulatedRoot();
    const ok = await cli(root, ["run", "WAX-600"], makeFakeHarness().deps);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("WAX-600");
    expect(ok.stdout).toContain("mode: pinned");
    expect(ok.stdout).toContain("reproduced");

    const cross = await cli(root, ["run", "exp-1"]);
    expect(cross.code).toBe(1);
    expect(cross.stderr).toContain('scenario "exp-1" not found in repros/');
  });

  test("an invalid declaration is an actionable error, exit 1", async () => {
    const root = makeRoot();
    addScenario(root, "repros", "broken", DRAFT_YAML);
    const result = await cli(root, ["run", "broken"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("persisted validation");
    expect(result.stderr).toContain("verdict");
  });
});

describe("override surface (D12)", () => {
  test("component override switches a persisted run to floating mode", async () => {
    const root = makePopulatedRoot();
    const harness = makeFakeHarness();
    const result = await cli(
      root,
      ["run", "wax-600", "--edge", "path:/tmp/edge"],
      harness.deps,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("mode: floating");
    // The report has to say what was actually run, or a floating verdict
    // cannot be traced back to the override that caused it.
    const report = JSON.parse(
      readFileSync(path.join(harness.runDir, "ass", "report.json"), "utf8"),
    );
    expect(report.selectors.edge).toBe("path:/tmp/edge");
    expect(report.target.mode).toBe("floating");
  });

  test("override naming an undeclared component lists the declared ones", async () => {
    const root = makePopulatedRoot();
    const result = await cli(root, [
      "run",
      "wax-600",
      "--component",
      "wasix=path:/tmp/wasix",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('undeclared component "wasix"');
    expect(result.stderr).toContain("declared components: backend, edge");
  });

  test("--executor naming an undeclared profile lists the declared ones", async () => {
    const root = makePopulatedRoot();
    const result = await cli(root, [
      "run",
      "wax-600",
      "--executor",
      "raw-wasmer",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('undeclared profile "raw-wasmer"');
    expect(result.stderr).toContain("declared profiles: jest");
  });

  test.each([
    [["--env", "staging"], "unknown --env"],
    [["--cpus", "0"], "--cpus must be a positive integer"],
    [["--cpus", "two"], "--cpus must be a positive integer"],
    [["--component", "edge"], "--component expects <name>=<selector>"],
    [
      ["--edge", "path:/a", "--component", "edge=path:/b"],
      'duplicate override for component "edge"',
    ],
    [["--env", "dev", "--env", "local"], "duplicate --env"],
    [["--cpus", "1", "--cpus", "2"], "duplicate --cpus"],
    [["--executor", "jest", "--executor", "jest"], "duplicate --executor"],
    [["--env"], "argument missing"],
    [["--frobnicate"], "unknown option '--frobnicate'"],
  ])("invalid overrides %j fail with %s", async (args, expected) => {
    const root = makePopulatedRoot();
    const result = await cli(root, ["run", "wax-600", ...args]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(expected);
  });

  test("inline --flag=value form parses", async () => {
    const root = makePopulatedRoot();
    const result = await cli(
      root,
      ["run", "wax-600", "--edge=path:/tmp/edge"],
      makeFakeHarness().deps,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("mode: floating");
  });

  test("environment-unevaluable verdicts fail preflight at the CLI", async () => {
    // PERSISTED_YAML's verdict greps the edge process stream: local-only (D7).
    const root = makePopulatedRoot();
    const result = await cli(root, ["run", "wax-600", "--env", "dev"]);
    expect(result.code).toBe(1);
    // The banner is already open, so the failure is reported inside the run's
    // table rather than escaping as a bare stderr line.
    expect(result.stdout).toContain("preflight failed");
    expect(result.stdout).toContain('"edge"');
    expect(result.stdout).toContain('"dev"');
    expect(result.stdout).toMatch(/^─+┴─+$/m); // and the frame is closed
  });
});

describe("command safety", () => {
  test("unknown commands and missing slugs are usage errors", async () => {
    const root = makePopulatedRoot();
    expect((await cli(root, ["frob"])).code).toBe(1);
    expect((await cli(root, ["try"])).code).toBe(1);
    expect((await cli(root, [])).code).toBe(1);
  });

  test("no run or override rewrites a scenario declaration", async () => {
    const root = makePopulatedRoot();
    const scenarios = ["experiments", "repros"];
    const before = snapshotTree(root, scenarios);
    for (const argv of [
      ["list"],
      ["try", "exp-1"],
      ["try", "exp-1", "--edge", "path:/tmp/edge"],
      ["run", "wax-600"],
      ["run", "wax-600", "--edge", "path:/tmp/edge"],
      ["run", "wax-600", "--env", "dev"],
      ["run", "missing"],
      // exp-1 has no verdict, so this is refused — and refusal moves nothing.
      ["promote", "exp-1"],
    ]) {
      await cli(root, argv, makeFakeHarness().deps);
    }
    expect(snapshotTree(root, scenarios)).toEqual(before);
  });
});
