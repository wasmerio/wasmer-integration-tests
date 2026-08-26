// Unit tests for scenario slug resolution and loading: case-insensitive
// lookup, strict experiments/-vs-repros/ boundaries, deterministic ambiguity
// errors, and actionable load errors.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AmbiguousSlugError,
  listScenarios,
  loadScenario,
  resolveSlug,
  rootsFrom,
  ScenarioLoadError,
  ScenarioNotFoundError,
} from "../../ass/scenario/loader";
import { addScenario, DRAFT_TOML, makeRoot, PERSISTED_TOML } from "./helpers";

describe("resolveSlug", () => {
  test("slugs resolve case-insensitively against lowercase directories", () => {
    const root = makeRoot();
    addScenario(root, "repros", "wax-600", PERSISTED_TOML);
    const ref = resolveSlug(rootsFrom(root), "repro", "WAX-600");
    expect(ref.slug).toBe("wax-600");
    expect(ref.dir).toBe(path.join(root, "repros", "wax-600"));
  });

  test("unknown slug raises a not-found error naming the searched boundary", () => {
    const root = makeRoot();
    addScenario(root, "repros", "wax-600", PERSISTED_TOML);
    let error: unknown;
    try {
      resolveSlug(rootsFrom(root), "experiment", "wax-600");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ScenarioNotFoundError);
    expect((error as Error).message).toContain("experiments/");
    expect((error as Error).message).toContain("ass run");
  });

  test("case-colliding directories raise a deterministic ambiguity error", () => {
    const root = makeRoot();
    addScenario(root, "repros", "wax-601", PERSISTED_TOML);
    try {
      addScenario(root, "repros", "WAX-601", PERSISTED_TOML);
    } catch {
      // Case-insensitive filesystem: the collision cannot exist here.
      return;
    }
    let error: unknown;
    try {
      resolveSlug(rootsFrom(root), "repro", "wax-601");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AmbiguousSlugError);
    expect((error as Error).message).toContain("WAX-601, wax-601");
  });

  test("a directory without scenario.toml is not a scenario", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "repros", "not-a-scenario"), { recursive: true });
    expect(() =>
      resolveSlug(rootsFrom(root), "repro", "not-a-scenario"),
    ).toThrow(ScenarioNotFoundError);
  });
});

describe("listScenarios", () => {
  test("lists the union of both boundaries, sorted, with kinds", () => {
    const root = makeRoot();
    addScenario(root, "experiments", "exp-b", DRAFT_TOML);
    addScenario(root, "repros", "wax-600", PERSISTED_TOML);
    addScenario(root, "experiments", "exp-a", DRAFT_TOML);
    mkdirSync(path.join(root, "repros", "no-toml-here"));
    expect(listScenarios(rootsFrom(root)).map((r) => [r.slug, r.kind])).toEqual(
      [
        ["exp-a", "experiment"],
        ["exp-b", "experiment"],
        ["wax-600", "repro"],
      ],
    );
  });

  test("missing scenario directories yield an empty list", () => {
    expect(listScenarios(rootsFrom(makeRoot()))).toEqual([]);
  });
});

describe("loadScenario", () => {
  test("experiments load with draft validation, repros with strict validation", () => {
    const root = makeRoot();
    addScenario(root, "experiments", "exp-1", DRAFT_TOML);
    addScenario(root, "repros", "wax-600", PERSISTED_TOML);
    const draft = loadScenario(rootsFrom(root), "experiment", "exp-1");
    expect(draft.scenario.meta.lifecycle).toEqual({ state: "open" });
    const persisted = loadScenario(rootsFrom(root), "repro", "wax-600");
    expect(persisted.scenario.meta.id).toBe("WAX-600");
  });

  test("a draft in repros/ fails strict validation with actionable issues", () => {
    const root = makeRoot();
    addScenario(root, "repros", "exp-1", DRAFT_TOML);
    let error: unknown;
    try {
      loadScenario(rootsFrom(root), "repro", "exp-1");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ScenarioLoadError);
    const message = (error as Error).message;
    expect(message).toContain("persisted validation");
    expect(message).toContain("fixtures.components.edge");
    expect(message).toContain("verdict: persisted scenarios require a verdict");
  });

  test("invalid TOML produces an actionable error naming the file", () => {
    const root = makeRoot();
    const dir = path.join(root, "experiments", "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "scenario.toml"), "meta = [unclosed");
    let error: unknown;
    try {
      loadScenario(rootsFrom(root), "experiment", "broken");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ScenarioLoadError);
    expect((error as Error).message).toContain("invalid TOML");
    expect((error as Error).message).toContain("scenario.toml");
  });
});
