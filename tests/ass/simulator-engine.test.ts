// The reconciler engine: the declaration half and the planner are pure, so every
// rule in the design is testable with no platform at all. These are the
// tables and properties named in the spec's testing section - diff tables
// per kind, additivity (P4), digest soundness (I9), determinism (I6),
// precision (P1/P3) and the budget refusal.

import {
  compareIds,
  fingerprint,
  id,
  key,
  type Resource,
} from "../../ass/simulator/model";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import { digestFingerprint } from "../../ass/simulator/digest";
import { runDiff, runDown } from "../../ass/simulator/verbs";
import { ESC } from "../../ass/report/style";
import {
  duration,
  planRows,
  ReconcileReporter,
} from "../../ass/simulator/render";
import {
  ledgerPath,
  writeLedger,
  type LedgerFile,
} from "../../ass/simulator/ledger";
import { IdentityMap } from "../../ass/simulator/identity";
import { planReconcile } from "../../ass/simulator/plan";
import { defaultDiff, type DiffContext } from "../../ass/simulator/adapter";
import { diffBucket } from "../../ass/simulator/adapters/requests";
import {
  buildWorld,
  expandKind,
  summarizeExpansion,
  ExpansionError,
} from "../../ass/simulator/expand";
import {
  validateDeclaration,
  upgradeV1,
  parseOffsetMs,
} from "../../ass/simulator/scenario";
import {
  resolveWorkers,
  Semaphore,
  mapConcurrent,
} from "../../ass/simulator/engine/context";
import {
  stageKinds,
  assertMutationStats,
} from "../../ass/simulator/engine/scheduler";
import type { RequestBucketSpec } from "../../ass/simulator/specs";

const ANCHOR = Date.parse("2026-08-18T20:00:00Z");

function declaration(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    assSchema: 2,
    name: "unit",
    seed: 4242,
    account: {
      username: "unit-user",
      password: "Unit1!pass",
      namespace: "unit",
    },
    apps: { count: 2, real: 0, deployments: { perApp: 2, failed: 1 } },
    telemetry: {
      history: "2d",
      precision: { raw: "2h" },
      rps: { perAppBase: 1 },
      errorRate: { base: 0.01 },
    },
    billing: {
      plan: "scale",
      subscription: "active",
      invoices: { count: 3, failed: 1 },
    },
    ...overrides,
  };
}

function world(overrides: Record<string, unknown> = {}) {
  return buildWorld({
    declaration: validateDeclaration(declaration(overrides), "unit.toml"),
    seed: 4242,
    anchorMs: ANCHOR,
  });
}

function diffContext(overrides: Partial<DiffContext> = {}): DiffContext {
  return {
    exact: false,
    previousDigests: new Map(),
    desiredDigests: new Map(),
    previousRawFrom: new Map(),
    reportSurplus: () => undefined,
    ...overrides,
  };
}

function bucket(input: {
  app: string;
  hour: number;
  requests: number;
  mode?: "aggregate" | "raw";
}): Resource<RequestBucketSpec> {
  const spec: RequestBucketSpec = {
    namespace: "unit",
    app: input.app,
    epochHour: input.hour,
    mode: input.mode ?? "aggregate",
    requests: input.requests,
    http5xx: 0,
    errPermille: 10,
    latency: { p50: "45ms", p95: "300ms", p99: "900ms" },
    literals: 0,
    seed: 4242,
  };
  return {
    id: id(
      "request-bucket",
      "unit",
      input.app,
      String(input.hour).padStart(9, "0"),
    ),
    kind: "request-bucket",
    spec,
    fingerprint: fingerprint(spec),
    deps: [],
    policy: { prune: "delete", precision: spec.mode },
  };
}

describe("resource model", () => {
  it("orders ids by kind first, then segment by segment", () => {
    expect(
      compareIds(
        id("app", "unit", "a"),
        id("request-bucket", "unit", "a", "1"),
      ),
    ).toBeLessThan(0);
    expect(
      compareIds(id("app", "unit", "b"), id("app", "unit", "a")),
    ).toBeGreaterThan(0);
    expect(compareIds(id("app", "unit", "a"), id("app", "unit", "a"))).toBe(0);
  });

  it("fingerprints content, not key order", () => {
    expect(fingerprint({ a: 1, b: [2, { c: 3 }] })).toBe(
      fingerprint({ b: [2, { c: 3 }], a: 1 }),
    );
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });

  it("keeps bindings per kind and resolves them in reverse", () => {
    const identity = new IdentityMap();
    identity.bind(id("app", "unit", "checkout"), {
      pk: 42,
      externalId: "da_x",
    });
    expect(identity.requireNumber(id("app", "unit", "checkout"), "pk")).toBe(
      42,
    );
    expect(key(identity.byNative("app", "pk", 42) as never)).toBe(
      "app:unit/checkout",
    );
    expect(() => identity.require(id("app", "unit", "other"), "pk")).toThrow(
      /refuses to guess/,
    );
  });
});

describe("expansion (declaration half)", () => {
  it("is pure in (declaration, seed, anchor) - invariant I6", () => {
    const first = [...expandKind(world(), "request-bucket")].map(
      (resource) => resource.fingerprint,
    );
    const second = [...expandKind(world(), "request-bucket")].map(
      (resource) => resource.fingerprint,
    );
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });

  it("emits every kind in id order, which the merge-join depends on", () => {
    for (const kind of [
      "app",
      "app-version",
      "invoice",
      "request-bucket",
      "workload-bucket",
      "usage-period",
    ] as const) {
      const resources = [
        ...expandKind(world({ apps: { count: 3, real: 0 } }), kind),
      ];
      for (let index = 1; index < resources.length; index++) {
        expect(
          compareIds(resources[index - 1].id, resources[index].id),
        ).toBeLessThan(0);
      }
    }
  });

  it("resolves precision per app and per hour (P1)", () => {
    const expanded = [
      ...expandKind(
        world({
          telemetry: {
            history: "2d",
            precision: { raw: "2h", apps: { "noble-reef-1": { raw: "24h" } } },
            rps: { perAppBase: 1 },
          },
        }),
        "request-bucket",
      ),
    ] as Array<Resource<RequestBucketSpec>>;
    const perApp = new Map<string, number>();
    for (const resource of expanded) {
      if (resource.spec.mode === "raw") {
        perApp.set(resource.spec.app, (perApp.get(resource.spec.app) ?? 0) + 1);
      }
    }
    const counts = [...perApp.values()].sort((a, b) => a - b);
    // One app keeps the 2h default, the widened one gets 24 hours.
    expect(counts).toEqual([2, 24]);
  });

  it("refuses a plan over the row budget instead of writing it", () => {
    expect(() =>
      summarizeExpansion(
        world({
          telemetry: {
            history: "2d",
            precision: { raw: "48h" },
            rps: { perAppBase: 250 },
            rowBudget: 1000,
          },
        }),
      ),
    ).toThrow(ExpansionError);
  });

  it("refuses a declared log older than the app_logs TTL (Q-G)", () => {
    expect(() => [
      ...expandKind(
        world({
          telemetry: {
            history: "30d",
            precision: { raw: "2h" },
            rps: { perAppBase: 1 },
            logs: [{ app: "noble-reef-1", at: "-20d", message: "too old" }],
          },
        }),
        "log-line",
      ),
    ]).toThrow(/14d TTL/);
  });

  it("upgrades an assSchema=1 declaration onto the current shape", () => {
    const upgraded = upgradeV1({
      assSchema: 1,
      name: "legacy",
      account: { username: "u", password: "p", namespace: "n" },
      apps: { count: 4 },
      telemetry: { history: "90d", rawWindow: "48h", rps: { base: 10 } },
    });
    const parsed = validateDeclaration(upgraded, "legacy.toml");
    expect(parsed.assSchema).toBe(2);
    expect(parsed.telemetry?.precision.raw).toBe("48h");
    // The portfolio-total base becomes the count-stable per-app mean.
    expect(parsed.telemetry?.rps.perAppBase).toBe(2.5);
  });

  it("refuses rps.base on an assSchema=2 declaration, naming the migration", () => {
    expect(() =>
      validateDeclaration(
        declaration({
          telemetry: { history: "2d", rps: { base: 40 } },
        }),
        "unit.toml",
      ),
    ).toThrow(/perAppBase/);
  });

  it("keeps existing apps' traffic verbatim when apps.count grows", () => {
    const small = world();
    const large = world({
      apps: { count: 3, real: 0, deployments: { perApp: 2, failed: 1 } },
    });
    expect(large.traffic).not.toBeNull();
    for (const [index, hour] of small.traffic!.hours.entries()) {
      expect(large.traffic!.hours[index].perApp.slice(0, 2)).toEqual(
        hour.perApp,
      );
    }
    for (const [index, hour] of small.traffic!.workloadHours.entries()) {
      expect(large.traffic!.workloadHours[index].perApp.slice(0, 2)).toEqual(
        hour.perApp,
      );
    }
  });

  it("parses compound sub-second offsets", () => {
    expect(parseOffsetMs("-2h15m30s")).toBe(-(2 * 3600 + 15 * 60 + 30) * 1000);
    expect(parseOffsetMs("-500ms")).toBe(-500);
  });
});

describe("digests (section 9.2, D1/I9)", () => {
  it("changes when any member changes - digest soundness", () => {
    const base = {
      members: 24,
      sums: { requests: 1000, http5xx: 3 },
      weighted: 12_000,
    };
    expect(digestFingerprint(base)).toBe(digestFingerprint({ ...base }));
    expect(digestFingerprint({ ...base, members: 23 })).not.toBe(
      digestFingerprint(base),
    );
    expect(
      digestFingerprint({ ...base, sums: { requests: 1001, http5xx: 3 } }),
    ).not.toBe(digestFingerprint(base));
    // The position-weighted term is what makes a redistribution of the same
    // daily total across hours visible; a digest of sums alone is not one.
    expect(digestFingerprint({ ...base, weighted: 12_001 })).not.toBe(
      digestFingerprint(base),
    );
  });

  it("is reproduced by the declaration half for every day it declares", () => {
    const days = [...expandKind(world(), "request-day")];
    expect(days.length).toBeGreaterThan(0);
    for (const day of days) {
      const spec = day.spec as {
        members: number;
        sums: Record<string, number>;
        weighted: number;
      };
      expect(day.fingerprint).toBe(digestFingerprint(spec));
    }
  });
});

describe("bucket diffing (section 7.3, normative)", () => {
  const desired = bucket({ app: "checkout", hour: 486_312, requests: 100 });

  it("patches a shortfall at the recorded offset", () => {
    const observed = bucket({ app: "checkout", hour: 486_312, requests: 60 });
    const ops = diffBucket(
      desired,
      observed,
      diffContext(),
      (spec) => spec.requests,
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("patch");
    expect(ops[0].detail).toEqual({ delta: 40, offset: 60 });
  });

  it("P4: a surplus alone never authorizes a write, but is reported", () => {
    const observed = bucket({ app: "checkout", hour: 486_312, requests: 140 });
    const surplus: Array<{ desired: number; observed: number }> = [];
    const ops = diffBucket(
      desired,
      observed,
      diffContext({ reportSurplus: (entry) => surplus.push(entry) }),
      (spec) => spec.requests,
    );
    expect(ops).toEqual([]);
    expect(surplus).toEqual([{ id: desired.id, desired: 100, observed: 140 }]);
  });

  it("--exact turns a surplus into a replace", () => {
    const observed = bucket({ app: "checkout", hour: 486_312, requests: 140 });
    const ops = diffBucket(
      desired,
      observed,
      diffContext({ exact: true }),
      (spec) => spec.requests,
    );
    expect(ops.map((op) => op.type)).toEqual(["replace"]);
  });

  it("a declared decrease replaces without --exact", () => {
    const dayKey = "request-day:unit/checkout/0020263";
    const ops = diffBucket(
      desired,
      bucket({ app: "checkout", hour: 486_312, requests: 140 }),
      diffContext({
        previousDigests: new Map([[dayKey, "old"]]),
        desiredDigests: new Map([[dayKey, "new"]]),
      }),
      (spec) => spec.requests,
    );
    expect(ops.map((op) => op.type)).toEqual(["replace"]);
  });

  it("falls back to additive when the ledger has no entry", () => {
    const ops = diffBucket(
      desired,
      bucket({ app: "checkout", hour: 486_312, requests: 140 }),
      diffContext({
        desiredDigests: new Map([["request-day:unit/checkout/0020263", "new"]]),
      }),
      (spec) => spec.requests,
    );
    expect(ops).toEqual([]);
  });

  it("leaves undeclared state alone unless the run is exact", () => {
    const observed = bucket({ app: "checkout", hour: 486_312, requests: 10 });
    expect(
      diffBucket(null, observed, diffContext(), (spec) => spec.requests),
    ).toEqual([]);
    expect(
      diffBucket(
        null,
        observed,
        diffContext({ exact: true }),
        (spec) => spec.requests,
      ).map((op) => op.type),
    ).toEqual(["delete"]);
  });

  it("P3: a mode change is an explicit promote/demote, never an overwrite", () => {
    const hour = 486_312;
    const raw = bucket({ app: "checkout", hour, requests: 100, mode: "raw" });
    const observed = bucket({ app: "checkout", hour, requests: 100 });
    const promoted = diffBucket(
      raw,
      observed,
      diffContext({
        previousRawFrom: new Map([["checkout", (hour + 5) * 3600]]),
      }),
      (spec) => spec.requests,
    );
    expect(promoted.map((op) => op.type)).toEqual(["promote"]);
    const demoted = diffBucket(
      bucket({ app: "checkout", hour, requests: 100 }),
      observed,
      diffContext({
        previousRawFrom: new Map([["checkout", (hour - 5) * 3600]]),
      }),
      (spec) => spec.requests,
    );
    expect(demoted.map((op) => op.type)).toEqual(["demote"]);
  });
});

describe("the planner", () => {
  const adapter = {
    kind: "app" as const,
    lane: "sdk" as const,
    granularity: "resource" as const,
    observe: async () => [],
    diff: (desired: Resource | null, observed: Resource | null) =>
      defaultDiff("sdk", desired, observed),
    apply: async () => [],
  };

  const resource = (name: string, print: string): Resource => ({
    id: id("app", "unit", name),
    kind: "app",
    spec: { name },
    fingerprint: print,
    deps: [],
    policy: { prune: "delete" },
  });

  const plan = (desired: Resource[], observed: Resource[]) =>
    planReconcile({
      desired,
      observed,
      adapters: new Map([["app", adapter]]),
      diffContext: diffContext(),
    });

  it("merge-joins two sorted streams into create/update/delete", () => {
    const result = plan(
      [resource("a", "1"), resource("b", "2"), resource("d", "4")],
      [resource("b", "changed"), resource("c", "3"), resource("d", "4")],
    );
    expect(
      result.operations.map((op) => `${op.type}:${op.id.segments[1]}`),
    ).toEqual(["create:a", "update:b", "delete:c"]);
    expect(result.keeps).toBe(1);
  });

  it("never deletes a retained resource (I4, the pinned superuser)", () => {
    const retained: Resource = {
      ...resource("keep", "1"),
      policy: { prune: "retain" },
    };
    expect(plan([], [retained]).operations).toEqual([]);
  });

  it("refuses an out-of-order stream instead of planning nonsense", () => {
    expect(() => plan([resource("b", "1"), resource("a", "2")], [])).toThrow(
      /out of order/,
    );
  });
});

describe("the scheduler", () => {
  it("stages kinds by their declared dependencies, not by a fixed pipeline", () => {
    const operation = (
      kind: "app" | "namespace" | "request-bucket",
      deps: string[],
    ) => ({
      type: "create" as const,
      id: id(kind, "unit", "x"),
      kind,
      lane: "sdk" as const,
      desired: {
        id: id(kind, "unit", "x"),
        kind,
        spec: {},
        fingerprint: "f",
        deps: deps.map((dep) => id(dep as "app", "unit", "x")),
        policy: { prune: "delete" as const },
      },
      observed: null,
    });
    const stages = stageKinds(
      [
        operation("request-bucket", ["app"]),
        operation("app", ["namespace"]),
        operation("namespace", []),
      ],
      new Map(),
    );
    expect(stages).toEqual([["namespace"], ["app"], ["request-bucket"]]);
  });

  it("enforces the mutation budget (A1: one delete per table per reconcile)", () => {
    expect(() =>
      assertMutationStats({ "mutation:request_log": 1 }),
    ).not.toThrow();
    expect(() => assertMutationStats({ "mutation:request_log": 2 })).toThrow(
      /mutation budget/,
    );
  });

  it("resolves worker widths from flags, env and bounds", () => {
    expect(resolveWorkers({}, {}, 4).global).toBe(4);
    expect(resolveWorkers({ workers: 99 }, {}, 4).global).toBe(64);
    expect(resolveWorkers({}, { SIM_WORKERS: "3" }, 16)).toMatchObject({
      global: 3,
      clickhouse: 3,
    });
    expect(resolveWorkers({ workersClickhouse: 40 }, {}, 8).clickhouse).toBe(
      16,
    );
  });

  it("preserves input order under concurrency (I6)", async () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    const results = await mapConcurrent(items, 8, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, (20 - item) % 5));
      return item * 2;
    });
    expect(results).toEqual(items.map((item) => item * 2));
  });

  it("bounds a lane to its width", async () => {
    const lane = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        lane.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe("output rendering", () => {
  const plan = (counts: Record<string, Record<string, number>>, keeps = 0) =>
    ({ operations: [], surplus: [], keeps, counts }) as never;

  /** The reporter speaks through ASS's presenter, so the assertion surface
   * is the same table the rest of the tool prints. */
  function capture(drive: (reporter: ReconcileReporter) => void): string[] {
    const lines: string[] = [];
    const reporter = new ReconcileReporter({
      io: { out: (line) => lines.push(line), err: () => undefined },
      color: false,
    });
    drive(reporter);
    return lines;
  }

  it("orders rows by dependency, not alphabetically", () => {
    const rows = planRows(
      plan({
        "request-bucket": { create: 25920 },
        app: { create: 12 },
        user: { create: 1 },
      }),
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "user",
      "app",
      "request-bucket",
    ]);
  });

  it("splits a kind with several verbs into one row each, escalating", () => {
    const rows = planRows(plan({ "request-bucket": { delete: 3, patch: 9 } }));
    expect(rows.map((row) => `${row.verb} ${row.count}`)).toEqual([
      "patch 9",
      "delete 3",
    ]);
  });

  it("prints durations in the unit that carries information", () => {
    expect(duration(42)).toBe("42ms");
    expect(duration(3520)).toBe("3.5s");
    expect(duration(74_000)).toBe("1m14s");
  });

  it("renders into ass's own table, with the plan as a step", () => {
    const lines = capture((reporter) => {
      reporter.banner("local-dev", "reconcile");
      reporter.plan(
        plan({ app: { create: 12 }, "request-bucket": { create: 25920 } }, 4),
      );
      reporter.close();
    });
    // The banner opens the frame, the step carries the key column, and the
    // rows continue it - exactly what `ass run` prints.
    expect(lines[1]).toMatch(/^ASS {2}local-dev {2}reconcile$/);
    expect(lines.some((line) => line.includes("┬"))).toBe(true);
    expect(
      lines.some((line) => /plan │ create: 25,932 · keep: 4/.test(line)),
    ).toBe(true);
    expect(lines.at(-1)).toContain("┴");
  });

  it("aligns the apply rows under the plan rows", () => {
    const lines = capture((reporter) => {
      reporter.plan(
        plan({ app: { create: 12 }, "request-bucket": { create: 25920 } }),
      );
      reporter.applied({ kind: "app", ops: 12, ms: 640, failed: false });
    });
    const planned = lines.find((line) =>
      line.includes("create apps"),
    ) as string;
    const applied = lines.find((line) => line.includes("wrote apps")) as string;
    // Exact spacing is the point of the test, but the widths come from the
    // renderer, so the assertion is that the columns *agree*.
    expect(planned).toMatch(/create apps\s+12$/);
    expect(applied).toMatch(/wrote apps\s+12 {2}640ms$/);
    expect(applied.indexOf("12")).toBe(planned.indexOf("12"));
  });

  it("closes with ass's own summary table", () => {
    const lines = capture((reporter) => {
      reporter.plan(plan({}, 2434));
      reporter.summary({
        slug: "local-dev",
        outcome: "converged",
        operations: 0,
        totalMs: 318,
        observeMs: 235,
        diffMs: 83,
        signIn: {
          dashboard: "http://localhost:8082",
          username: "local-dev-user",
          password: "LocalDev1!pass",
          namespace: "localdev",
        },
      });
    });
    const text = plainText(lines);
    expect(lines[0]).toContain("plan │ converged: 2,434 resources match");
    // The same rows `ass run` closes with: a glyphed outcome, then facts.
    expect(text).toMatch(/● converged/);
    expect(text).toMatch(
      /no changes · took 318ms · observed 235ms · diffed 83ms/,
    );
    expect(text).toMatch(/http:\/\/localhost:8082\/signin/);
    expect(text).toMatch(/local-dev-user \/ LocalDev1!pass/);
    expect(text).toMatch(/http:\/\/localhost:8082\/localdev/);
    expect(lines.at(-1)).toContain("┴");
  });

  it("emits no escape sequences when colour is off", () => {
    const lines = capture((reporter) => {
      reporter.banner("unit", "reconcile");
      reporter.plan(plan({ app: { create: 1 } }));
      reporter.applied({ kind: "app", ops: 1, ms: 5, failed: false });
      reporter.close();
    });
    expect(lines.join("\n")).not.toContain(ESC);
  });
});

/** The framed table's prose, with the frame and its wrapping taken out. */
function plainText(lines: string[]): string {
  return lines
    .map((line) => line.replace(/^\s*\S*\s*│\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

describe("verbs against a platform that is not running", () => {
  // `make local-dev-down` destroys the stack and *then* releases held
  // scenarios, so "no platform" is the normal case for teardown - and
  // booting one there costs minutes and can fail, which it did.
  function fakeDriver(root: string, live: boolean) {
    const calls: string[] = [];
    return {
      calls,
      driver: {
        repoDir: root,
        applyPins: () => undefined,
        applyCpus: () => undefined,
        wipeCaches: () => undefined,
        restoreFiles: () => [],
        up: async () => {
          calls.push("up");
        },
        down: async () => null,
        currentRunDir: () => (live ? "/fake/run" : null),
        readTestEnv: () => ({
          WASMER_REGISTRY: "http://localhost:18000/graphql",
          WASMER_TOKEN: "t",
          LOCAL_PLATFORM_POSTGRES_URL: "postgresql://p:p@localhost:15432/wapm",
          LOCAL_PLATFORM_CLICKHOUSE_URL: "http://localhost:18123",
        }),
        readResolvedEnv: () => ({}),
        composeFollowLogPath: () => "/fake/log",
        edgePlatformConfigPath: () => "/fake/config",
      },
    };
  }

  function heldLedger(root: string): LedgerFile {
    const declared = validateDeclaration(declaration(), "unit.toml");
    return {
      stateVersion: 2,
      slug: "unit",
      mode: "up",
      assSchema: 2,
      scenarioPath: path.join(root, "unit.toml"),
      seed: 4242,
      declarationDigest: "d",
      heldAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      ownsPlatform: true,
      overrides: {},
      declaration: declared,
      anchorMs: ANCHOR,
      workers: {},
      perKindCounts: {},
      digests: {},
      rawFrom: {},
      identity: [],
      surface: { apps: 0, totalRequests: 0, daily: [] },
      teardown: [],
    };
  }

  it("down releases the hold instead of booting a platform", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sim-engine-down-"));
    writeLedger(root, heldLedger(root));
    const fake = fakeDriver(root, false);
    const out: string[] = [];
    const code = await runDown({
      slug: "unit",
      cwd: root,
      io: { out: (line) => out.push(line), err: () => undefined },
      deps: { driver: fake.driver as never },
    });
    expect(code).toBe(0);
    expect(fake.calls).not.toContain("up");
    // The presenter wraps and frames its rows, so the assertion is on the
    // message, not on its layout.
    expect(plainText(out)).toMatch(/releasing the held state/);
    expect(existsSync(ledgerPath(root, "unit"))).toBe(false);
  });

  it("diff prints the expansion instead of booting a platform", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sim-engine-diff-"));
    writeFileSync(path.join(root, "unit.toml"), stringifyToml(declaration()));
    const fake = fakeDriver(root, false);
    const out: string[] = [];
    const code = await runDiff({
      file: "unit.toml",
      cwd: root,
      io: { out: (line) => out.push(line), err: () => undefined },
      deps: { driver: fake.driver as never },
    });
    expect(code).toBe(0);
    expect(fake.calls).not.toContain("up");
    expect(plainText(out)).toMatch(/no live local platform/);
    expect(plainText(out)).toMatch(/expansion: 1 user/);
  });

  it("verify fails when there is no platform to verify against", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sim-engine-verify-"));
    writeFileSync(path.join(root, "unit.toml"), stringifyToml(declaration()));
    const fake = fakeDriver(root, false);
    const code = await runDiff({
      file: "unit.toml",
      verifyMode: true,
      cwd: root,
      io: { out: () => undefined, err: () => undefined },
      deps: { driver: fake.driver as never },
    });
    expect(code).not.toBe(0);
    expect(fake.calls).not.toContain("up");
  });
});
