// Trial-2 upgrades: `--set` overrides (tweak without editing the file),
// the additive-delta classifier, and the delta model math (old + delta ==
// new, exactly) that lets a per-app surge skip the world rebuild.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadDeclarationFile,
  parseDeclaration,
  parseOverride,
} from "../../ass/simulator/schema";
import { digestDeclaration } from "../../ass/simulator/descriptor";
import { classifyDelta } from "../../ass/simulator/delta";
import {
  expandTraffic,
  resolvePerAppMultipliers,
} from "../../ass/simulator/traffic";
import { appNames } from "../../ass/simulator/names";
import { seededRandom } from "../../ass/simulator/random";

const BASE_YAML = [
  "assSchema: 1",
  "name: t-delta",
  "seed: 1337",
  "account: { username: u, password: p, namespace: n }",
  "apps: { count: 4 }",
  "telemetry:",
  "  history: 2d",
  "  rawWindow: 3h",
  "  rps:",
  "    base: 2",
].join("\n");

function writeScenario(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sim-delta-"));
  const file = path.join(dir, "t-delta.yaml");
  writeFileSync(file, BASE_YAML);
  return file;
}

describe("--set overrides", () => {
  test("parse grammar: scalars, dotted paths, refusals", () => {
    expect(parseOverride("apps.count=13")).toEqual({
      path: ["apps", "count"],
      value: 13,
    });
    expect(parseOverride("telemetry.rps.perApp.quiet-harbor-11=2")).toEqual({
      path: ["telemetry", "rps", "perApp", "quiet-harbor-11"],
      value: 2,
    });
    expect(parseOverride("billing.subscription=past_due").value).toBe(
      "past_due",
    );
    expect(() => parseOverride("nope")).toThrow(/--set expects/);
    expect(() => parseOverride("=3")).toThrow(/--set expects/);
  });

  test("overrides change the declaration and the digest, and are recorded", () => {
    const file = writeScenario();
    const plain = loadDeclarationFile(file);
    const tweaked = loadDeclarationFile(file, ["apps.count=13"]);
    expect(plain.declaration.apps?.count).toBe(4);
    expect(tweaked.declaration.apps?.count).toBe(13);
    expect(tweaked.overrides).toEqual({ "apps.count": "13" });
    expect(digestDeclaration(tweaked.raw)).not.toBe(
      digestDeclaration(plain.raw),
    );
    // Same overrides ⇒ same digest (D-I no-op works for --set reruns).
    const again = loadDeclarationFile(file, ["apps.count=13"]);
    expect(digestDeclaration(again.raw)).toBe(digestDeclaration(tweaked.raw));
  });

  test("an override that breaks the schema fails with schema errors", () => {
    const file = writeScenario();
    expect(() => loadDeclarationFile(file, ["apps.count=-1"])).toThrow(
      /invalid declaration/,
    );
    // Creating intermediate objects works (perApp under default rps).
    const surged = loadDeclarationFile(file, [
      "telemetry.rps.perApp.some-app=2",
    ]);
    expect(surged.declaration.telemetry?.rps.perApp).toEqual({
      "some-app": 2,
    });
  });
});

describe("delta classifier", () => {
  const held = parseDeclaration(BASE_YAML, "t.yaml");
  const withPerApp = (perApp: string): ReturnType<typeof parseDeclaration> =>
    parseDeclaration(BASE_YAML + `\n    perApp: ${perApp}`, "t.yaml");

  test("pure multiplier increase classifies as surge", () => {
    const next = withPerApp("{ a-app: 2 }");
    const classified = classifyDelta(held, next);
    expect(classified).toEqual({
      kind: "surge",
      surged: { "a-app": [1, 2] },
    });
  });

  test("increase on top of an existing multiplier classifies", () => {
    const previous = withPerApp("{ a-app: 2 }");
    const next = withPerApp("{ a-app: 3 }");
    expect(classifyDelta(previous, next)).toEqual({
      kind: "surge",
      surged: { "a-app": [2, 3] },
    });
  });

  test("decreases, other-field changes, and seed changes refuse", () => {
    expect(classifyDelta(withPerApp("{ a-app: 2 }"), held).kind).toBe("other");
    const countChanged = parseDeclaration(
      BASE_YAML.replace("count: 4", "count: 5") + "\n    perApp: { a: 2 }",
      "t.yaml",
    );
    expect(classifyDelta(held, countChanged).kind).toBe("other");
    const seedChanged = parseDeclaration(
      BASE_YAML.replace("seed: 1337", "seed: 1") + "\n    perApp: { a: 2 }",
      "t.yaml",
    );
    expect(classifyDelta(held, seedChanged).kind).toBe("other");
    expect(classifyDelta(held, held).kind).toBe("other");
  });
});

describe("delta model math", () => {
  test("old + delta == new, per hour, per app, and in the daily totals", () => {
    const declaration = parseDeclaration(BASE_YAML, "t.yaml");
    const telemetry = declaration.telemetry!;
    const anchor = Date.UTC(2026, 7, 14, 12, 30);
    const names = appNames(seededRandom(1337).fork("fabricated-names"), 4);
    const surged = names[2];
    const next = parseDeclaration(
      BASE_YAML + `\n    perApp: { ${surged}: 2 }`,
      "t.yaml",
    );
    const oldModel = expandTraffic(telemetry, 1337, 4, anchor);
    const newModel = expandTraffic(
      next.telemetry!,
      1337,
      4,
      anchor,
      resolvePerAppMultipliers(next.telemetry!.rps.perApp, names),
    );
    let added = 0;
    newModel.hours.forEach((hour, index) => {
      hour.perApp.forEach((count, app) => {
        const delta = count - oldModel.hours[index].perApp[app];
        expect(delta).toBeGreaterThanOrEqual(0);
        if (app !== 2) {
          // Only the surged app moves; every other app is byte-identical.
          expect(delta).toBe(0);
        }
        added += delta;
      });
    });
    expect(added).toBe(newModel.totalRequests - oldModel.totalRequests);
    expect(added).toBeGreaterThan(0);
    // Daily projections agree with the summed hour deltas.
    const dailyDelta = newModel.daily.reduce(
      (sum, day, index) => sum + day.requests - oldModel.daily[index].requests,
      0,
    );
    expect(dailyDelta).toBe(added);
  });
});
