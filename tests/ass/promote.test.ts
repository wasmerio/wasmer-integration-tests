// Promotion tests (Phase 3): a draft graduates to repros/ only from a recorded
// run that reproduced, pinned to what that run resolved, and every refusal
// leaves the tree exactly as it was.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import { readTryState } from "../../ass/engine/state";
import {
  addScenario,
  cli,
  DRAFT_YAML,
  makeFakeHarness,
  makeRoot,
  PROMOTABLE_DRAFT_YAML,
  snapshotTree,
} from "./helpers";

/** A root whose draft has been run once, the way promotion expects. */
async function makeTriedRoot(
  slug = "wax-999",
  yaml = PROMOTABLE_DRAFT_YAML,
): Promise<string> {
  const root = makeRoot();
  addScenario(root, "experiments", slug, yaml);
  const result = await cli(root, ["try", slug], makeFakeHarness().deps);
  expect(result.code).toBe(0);
  return root;
}

describe("recorded try state", () => {
  test("a completed draft run records what it resolved", async () => {
    const root = await makeTriedRoot();
    const state = readTryState(root, "wax-999");
    expect(state).not.toBeNull();
    expect(state).toMatchObject({
      slug: "wax-999",
      env: "local",
      mode: "floating", // resolve_prod in the declaration
      outcome: "reproduced",
      executor: "jest",
      selectors: { edge: "resolve_prod" },
      pins: {
        edge: "github-release:wasmerio/edge:v2026-08-05_1_419b336_dev1:edge",
      },
    });
  });

  test("a draft run never alerts, however quiet it is", async () => {
    const root = makeRoot();
    addScenario(root, "experiments", "wax-999", PROMOTABLE_DRAFT_YAML);
    const harness = makeFakeHarness({
      composeLog: "edge-1  | all healthy\n",
      workload: { code: 0, stdout: "1 passed\n", stderr: "" },
    });
    const result = await cli(root, ["try", "wax-999"], harness.deps);
    // The same declaration under `ass run` would be repro rot, exit 2.
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("not-reproduced");
    expect(result.stdout).toContain("keep iterating");
    expect(readTryState(root, "wax-999")?.outcome).toBe("not-reproduced");
  });
});

describe("ass promote", () => {
  test("pins the resolved selector, stamps the lifecycle, keeps the comments", async () => {
    const root = await makeTriedRoot();
    const result = await cli(root, ["promote", "wax-999"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("promoted wax-999");

    const promotedPath = path.join(root, "repros", "wax-999", "scenario.yaml");
    const text = readFileSync(promotedPath, "utf8");
    expect(text).toContain("# floating on purpose while hunting");
    expect(text).toContain("lifecycle: { state: open }");
    const scenario = parseYaml(text) as {
      meta: { lifecycle: { state: string } };
      fixtures: { components: Record<string, string> };
    };
    expect(scenario.fixtures.components.edge).toBe(
      "github-release:wasmerio/edge:v2026-08-05_1_419b336_dev1:edge",
    );
    expect(scenario.meta.lifecycle.state).toBe("open");

    // The draft moved; its recorded state went with it.
    expect(existsSync(path.join(root, "experiments", "wax-999"))).toBe(false);
    expect(readTryState(root, "wax-999")).toBeNull();
  });

  test("the generated README carries the promotion's provenance", async () => {
    const root = await makeTriedRoot();
    await cli(root, ["promote", "wax-999"]);
    const readme = readFileSync(
      path.join(root, "repros", "wax-999", "README.md"),
      "utf8",
    );
    expect(readme).toContain("experiments/wax-999/scenario.yaml"); // source draft
    expect(readme).toContain("v2026-08-05_1_419b336_dev1"); // resolved version
    expect(readme).toContain("`local`, mode `floating`"); // target
    expect(readme).toContain("templates.test.ts"); // workload
    expect(readme).toContain("`reproduced`"); // verdict
    expect(readme).toContain("waived"); // D10 baseline disposition
    expect(readme).toContain("pnpm ass run wax-999");
  });

  test("the promoted scenario runs under strict validation", async () => {
    const root = await makeTriedRoot();
    await cli(root, ["promote", "wax-999"]);
    const result = await cli(root, ["run", "wax-999"], makeFakeHarness().deps);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("mode: pinned");
    expect(result.stdout).toContain("reproduced");
  });

  test("a draft with no recorded run explains the prerequisite", async () => {
    const root = makeRoot();
    addScenario(root, "experiments", "wax-999", PROMOTABLE_DRAFT_YAML);
    const before = snapshotTree(root, ["experiments", "repros"]);
    const result = await cli(root, ["promote", "wax-999"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "no `ass try wax-999` run has been recorded",
    );
    expect(snapshotTree(root, ["experiments", "repros"])).toEqual(before);
  });

  test("a draft edited since its run is refused", async () => {
    const root = await makeTriedRoot();
    const draft = path.join(root, "experiments", "wax-999", "scenario.yaml");
    writeFileSync(
      draft,
      readFileSync(draft, "utf8") + "\n# one more thought\n",
    );
    const result = await cli(root, ["promote", "wax-999"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("has changed since the recorded run");
    expect(existsSync(path.join(root, "repros", "wax-999"))).toBe(false);
  });

  test("a run that did not reproduce is not promotable", async () => {
    const root = makeRoot();
    addScenario(root, "experiments", "wax-999", PROMOTABLE_DRAFT_YAML);
    await cli(
      root,
      ["try", "wax-999"],
      makeFakeHarness({ composeLog: "edge-1  | all healthy\n" }).deps,
    );
    const result = await cli(root, ["promote", "wax-999"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ended "not-reproduced"');
    expect(existsSync(path.join(root, "repros", "wax-999"))).toBe(false);
  });

  test("a verdict-less draft is not promotable", async () => {
    const root = await makeTriedRoot("exp-1", DRAFT_YAML);
    const result = await cli(root, ["promote", "exp-1"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("declares no verdict");
    expect(existsSync(path.join(root, "repros", "exp-1"))).toBe(false);
  });

  test("a draft without a baseline or waiver is not promotable (D10)", async () => {
    const yaml = PROMOTABLE_DRAFT_YAML.replace(
      / {2}baseline:\n {4}waived:.*\n/,
      "",
    );
    const root = await makeTriedRoot("wax-999", yaml);
    const result = await cli(root, ["promote", "wax-999"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("verdict.baseline");
    expect(existsSync(path.join(root, "repros", "wax-999"))).toBe(false);
  });

  test("an unexercised native baseline is not promotable (D10, Phase 4)", async () => {
    // A declared engine that is not installed leaves the native-vs-guest
    // divergence unproven; persisting it would make the corpus claim a
    // differential it never ran.
    const yaml = PROMOTABLE_DRAFT_YAML.replace(
      / {2}baseline:\n {4}waived:.*\n/,
      "  baseline:\n    engine: go\n    entry: [main.go]\n",
    ).replace(
      // A host process produces no edge log, so the verdict needs one
      // executor-observable predicate for the baseline to be judgeable.
      "          pattern: object used with the wrong context\n",
      "          pattern: object used with the wrong context\n" +
        "      - output_matches: { pattern: kaboom }\n",
    );
    const root = makeRoot();
    addScenario(root, "experiments", "wax-999", yaml);
    const harness = makeFakeHarness();
    harness.deps.enginePresence = () => false;
    expect((await cli(root, ["try", "wax-999"], harness.deps)).code).toBe(0);
    expect(readTryState(root, "wax-999")?.baseline).toBe("engine-missing");

    const result = await cli(root, ["promote", "wax-999"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("did not exercise it (engine-missing)");
    expect(existsSync(path.join(root, "repros", "wax-999"))).toBe(false);
  });

  test("a selector that resolved to something unpinnable fails before the move", async () => {
    const root = makeRoot();
    addScenario(root, "experiments", "wax-999", PROMOTABLE_DRAFT_YAML);
    const harness = makeFakeHarness();
    // A local build is what a fix-verification run resolves to: concrete on
    // this machine, meaningless in a committed scenario.
    harness.deps.driver!.readResolvedEnv = () => ({
      EDGE_RESOLVED: "path:/home/dev/edge/target/release/edge",
    });
    await cli(root, ["try", "wax-999"], harness.deps);
    const result = await cli(root, ["promote", "wax-999"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("which is not a pin");
    expect(result.stderr).toContain("path: points at a local build");
    expect(existsSync(path.join(root, "repros", "wax-999"))).toBe(false);
    expect(
      existsSync(path.join(root, "experiments", "wax-999", "scenario.yaml")),
    ).toBe(true);
  });

  // R4-01: what gets pinned follows the *effective* selector the run used, not
  // the declaration. A component the developer overrode ran on something the
  // draft does not name, so keeping the declaration would persist evidence
  // from a version that was never booted.
  describe("a component overridden at try time (R4-01)", () => {
    const PINNED_DRAFT = PROMOTABLE_DRAFT_YAML.replace(
      "edge: resolve_prod",
      "edge: github-release:wasmerio/edge:v2026-07-16_1_fcdd9c4_dev1:edge",
    );
    const OVERRIDE =
      "github-release:wasmerio/edge:v2026-08-05_1_419b336_dev1:edge";

    async function triedWithOverride(
      resolvedEnv?: Record<string, string>,
    ): Promise<string> {
      const root = makeRoot();
      addScenario(root, "experiments", "wax-998", PINNED_DRAFT);
      const harness = makeFakeHarness();
      if (resolvedEnv !== undefined) {
        harness.deps.driver!.readResolvedEnv = () => resolvedEnv;
      }
      const tried = await cli(
        root,
        ["try", "wax-998", "--edge", OVERRIDE],
        harness.deps,
      );
      expect(tried.code).toBe(0);
      return root;
    }

    test("is pinned to what it resolved, not to the declaration it replaced", async () => {
      const root = await triedWithOverride();
      const result = await cli(root, ["promote", "wax-998"]);
      expect(result.code).toBe(0);
      // The declared 07-16 build was never booted; it must not survive.
      const text = readFileSync(
        path.join(root, "repros", "wax-998", "scenario.yaml"),
        "utf8",
      );
      const scenario = parseYaml(text) as {
        fixtures: { components: Record<string, string> };
      };
      expect(scenario.fixtures.components.edge).toBe(OVERRIDE);
      expect(text).not.toContain("v2026-07-16_1_fcdd9c4_dev1");
      // And the developer is told the declaration was not kept.
      expect(result.stdout).toContain("from your --component override");
      expect(result.stdout).toContain("v2026-07-16_1_fcdd9c4_dev1");
    });

    test("the provenance names the override rather than claiming the draft's pin", async () => {
      const root = await triedWithOverride();
      await cli(root, ["promote", "wax-998"]);
      const readme = readFileSync(
        path.join(root, "repros", "wax-998", "README.md"),
        "utf8",
      );
      expect(readme).toContain(`--component edge=${OVERRIDE}`);
      expect(readme).toContain("overriding the draft's");
      expect(readme).not.toContain("declared pinned in the draft");
    });

    test("an override that resolved to something unpinnable is refused", async () => {
      const root = await triedWithOverride({
        EDGE_RESOLVED: "path:/home/dev/edge/target/release/edge",
      });
      const result = await cli(root, ["promote", "wax-998"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("ran on the override");
      expect(result.stderr).toContain("which is not a pin");
      expect(existsSync(path.join(root, "repros", "wax-998"))).toBe(false);
      expect(
        existsSync(path.join(root, "experiments", "wax-998", "scenario.yaml")),
      ).toBe(true);
    });

    test("an untouched pinned component is still kept verbatim", async () => {
      const root = makeRoot();
      addScenario(root, "experiments", "wax-998", PINNED_DRAFT);
      await cli(root, ["try", "wax-998"], makeFakeHarness().deps);
      const result = await cli(root, ["promote", "wax-998"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("kept edge (already pinned)");
      const scenario = parseYaml(
        readFileSync(
          path.join(root, "repros", "wax-998", "scenario.yaml"),
          "utf8",
        ),
      ) as { fixtures: { components: Record<string, string> } };
      expect(scenario.fixtures.components.edge).toBe(
        "github-release:wasmerio/edge:v2026-07-16_1_fcdd9c4_dev1:edge",
      );
    });
  });

  // R4-05: the copy is the first irreversible step and owns its own unwind.
  test("a failure mid-move leaves no half-built repro", async () => {
    const root = await makeTriedRoot();
    // A draft whose README.md is a directory: the copy succeeds, then reading
    // the notes to carry over fails (EISDIR) with the target already written.
    const scenarioDir = path.join(root, "experiments", "wax-999");
    mkdirSync(path.join(scenarioDir, "README.md"));
    const result = await cli(root, ["promote", "wax-999"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the partial copy removed");
    expect(existsSync(path.join(root, "repros", "wax-999"))).toBe(false);
    // The draft, and its recorded run, survive for the retry.
    expect(existsSync(path.join(scenarioDir, "scenario.yaml"))).toBe(true);
    expect(readTryState(root, "wax-999")).not.toBeNull();
  });

  test("promotion never overwrites an existing repro", async () => {
    const root = await makeTriedRoot();
    addScenario(root, "repros", "wax-999", PROMOTABLE_DRAFT_YAML);
    const result = await cli(root, ["promote", "wax-999"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already exists");
  });
});
