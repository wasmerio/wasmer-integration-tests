// Pinning suite for the simulator's externally observable contract. Written
// in phase A ahead of the v1-deletion / engine-flattening refactor
// (phase B, done); the refactor was proven behavior-preserving by this
// suite, and it remains the behavior contract. Everything here drives
// public seams only: the CLI (`runCli`), the `simulatorDeps` fake seam
// (platform driver + store adapters), raw `.ass/state/*.held.json` files on
// disk, and the guarded client factories.
//
// Cases formerly tagged [v1] were rewritten in phase B onto the surviving
// engine through the adapter store seam, preserving every asserted
// contract; everything else survived phase B byte-for-byte.
//
// Behaviors pinned elsewhere and NOT duplicated here:
// - Math.random ban (grep walk over ass/simulator/) and the lifecycle rows
//   (reuse/converge/declared change/resume/corrupt state): simulator.test.ts.
// - Engine pure internals (expansion order, bucket diffing, planner,
//   renderer): simulator-engine.test.ts.
// - `--set` grammar at function level: simulator.test.ts (loader level);
//   the CLI-level pins below carry the contract.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { runCli, type CliOptions } from "../../ass/cli";
import { makeRoot } from "./helpers";
import type { PlatformDriver } from "../../ass/fixtures/localPlatform";
import { GuardRefusalError } from "../../ass/simulator/guard";
import { SimulatorBackend } from "../../ass/simulator/clients/graphql";
import { connectSimulatorPostgres } from "../../ass/simulator/clients/postgres";

type SimDeps = NonNullable<CliOptions["simulatorDeps"]>;
type FakeAdapter = NonNullable<SimDeps["adapters"]>[number];
type FakeResource = Awaited<ReturnType<FakeAdapter["observe"]>>[number];

const ANCHOR = "2026-08-18T20:00:00Z";

function localEnv(): Record<string, string> {
  return {
    WASMER_REGISTRY: "http://localhost:18000/graphql",
    WASMER_TOKEN: "wap_pin_token",
    WASMER_NAMESPACE: "pin-ns",
    LOCAL_PLATFORM_POSTGRES_URL:
      "postgresql://postgres:pg_pin_pw@localhost:15432/wapm",
    LOCAL_PLATFORM_CLICKHOUSE_URL: "http://localhost:18123",
  };
}

/** assSchema=2 declaration; small enough that a plan expands instantly. */
const V2_TOML = [
  "assSchema = 2",
  'name = "pin"',
  "seed = 42",
  'account = { username = "pin-user", password = "Pin1!pass", namespace = "pin-ns" }',
  "[apps]",
  "count = 2",
  "[telemetry]",
  'history = "2d"',
  'precision = { raw = "3h" }',
  "[telemetry.rps]",
  "base = 2",
  "[billing]",
  'plan = "scale"',
  'subscription = "active"',
  "invoices = { count = 3, failed = 1 }",
  "",
].join("\n");

/** The v1 spelling of the same world: root assSchema = 1, inline account,
 * `rawWindow` instead of `precision.raw`. Auto-upgrade must make the two
 * indistinguishable. */
const V1_SHAPED_TOML = V2_TOML.replace(
  "assSchema = 2",
  "assSchema = 1",
).replace('precision = { raw = "3h" }', 'rawWindow = "3h"');

const MINIMAL_V1_TOML = [
  "assSchema = 1",
  'name = "t-min"',
  "seed = 42",
  'account = { username = "sim-user", password = "sim-pass", namespace = "sim-ns" }',
  "",
].join("\n");

class FakeDriver implements PlatformDriver {
  readonly repoDir: string;
  runDir: string | null = null;
  env: Record<string, string>;
  calls: string[] = [];

  constructor(repoDir: string, env: Record<string, string> = localEnv()) {
    this.repoDir = repoDir;
    this.env = env;
  }

  applyPins(): void {
    this.calls.push("applyPins");
  }
  applyCpus(): void {
    this.calls.push("applyCpus");
  }
  wipeCaches(): void {
    this.calls.push("wipeCaches");
  }
  restoreFiles(): string[] {
    return [];
  }
  async up(): Promise<void> {
    this.calls.push("up");
    this.runDir = path.join(this.repoDir, "fake-run");
  }
  async down(): Promise<string | null> {
    this.calls.push("down");
    this.runDir = null;
    return null;
  }
  currentRunDir(): string | null {
    return this.runDir;
  }
  readTestEnv(): Record<string, string> {
    if (this.runDir === null) {
      throw new Error("no run dir");
    }
    return { ...this.env };
  }
  readResolvedEnv(): Record<string, string> {
    return {};
  }
  composeFollowLogPath(): string {
    return path.join(this.repoDir, "compose.log");
  }
  edgePlatformConfigPath(): string {
    return path.join(this.repoDir, "platform_config.yaml");
  }
}

interface Harness {
  root: string;
  driver: FakeDriver;
  /** The in-memory "platform" behind the fake adapters (the store seam). */
  store: Map<string, FakeResource>;
  applied: string[];
  downed: string[];
  deps: SimDeps;
}

/** A stateful fake adapter: observe reads the store, apply writes it. The
 * engine's own expand/observe/diff/apply loop runs for real. */
function fakeAdapter(harness: Harness, kind: FakeAdapter["kind"]): FakeAdapter {
  const keyOf = (resource: FakeResource): string =>
    `${resource.id.kind}:${resource.id.segments.join("/")}`;
  return {
    kind,
    lane: "sdk",
    granularity: "resource",
    async observe() {
      return [...harness.store.values()]
        .filter((resource) => resource.kind === kind)
        .sort((a, b) =>
          a.id.segments.join("/") < b.id.segments.join("/") ? -1 : 1,
        );
    },
    diff(desired, observed) {
      if (desired !== null && observed === null) {
        return [
          {
            type: "create",
            id: desired.id,
            kind,
            lane: "sdk",
            desired,
            observed: null,
          },
        ];
      }
      if (desired === null && observed !== null) {
        if (observed.policy.prune === "retain") {
          return [];
        }
        return [
          {
            type: "delete",
            id: observed.id,
            kind,
            lane: "sdk",
            desired: null,
            observed,
          },
        ];
      }
      if (
        desired !== null &&
        observed !== null &&
        desired.fingerprint !== observed.fingerprint
      ) {
        return [
          {
            type: "update",
            id: desired.id,
            kind,
            lane: "sdk",
            desired,
            observed,
          },
        ];
      }
      return [];
    },
    async apply(ops) {
      return ops.map((op) => {
        if (op.type === "delete") {
          const observed = op.observed as FakeResource;
          harness.store.delete(keyOf(observed));
          harness.downed.push(keyOf(observed));
        } else {
          const desired = op.desired as FakeResource;
          harness.store.set(keyOf(desired), desired);
          harness.applied.push(keyOf(desired));
        }
        return { id: op.id, ok: true };
      });
    },
  };
}

function makeHarness(): Harness {
  const root = makeRoot();
  const driver = new FakeDriver(root);
  const harness = {
    root,
    driver,
    store: new Map(),
    applied: [],
    downed: [],
  } as Omit<Harness, "deps"> as Harness;
  harness.deps = {
    driver,
    fetchImpl: async () => {
      if (driver.runDir === null) {
        throw new Error("ECONNREFUSED");
      }
      return { status: 400 };
    },
    adapters: (["user", "namespace"] as const).map((kind) =>
      fakeAdapter(harness, kind),
    ),
    now: () => 1_755_000_000_000,
  };
  return harness;
}

async function cliPin(
  harness: Harness,
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd: harness.root,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    color: false,
    simulatorDeps: harness.deps,
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

function writeScenario(root: string, name: string, toml: string): string {
  const file = path.join(root, name);
  writeFileSync(file, toml);
  return file;
}

function heldPath(root: string, slug: string): string {
  return path.join(root, ".ass", "state", `${slug}.held.json`);
}

function readHeld(root: string, slug: string): Record<string, unknown> {
  return JSON.parse(readFileSync(heldPath(root, slug), "utf8")) as Record<
    string,
    unknown
  >;
}

/** The v2 reporter frames output; assertions read words, not layout. */
function plain(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\S*\s*│\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

/** A hand-written v2 ledger (`stateVersion: 2`), written straight to disk:
 * the on-disk contract itself is the seam, no engine import needed. */
function writeV2Ledger(root: string, slug: string): string {
  const file = heldPath(root, slug);
  mkdirSync(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    file,
    JSON.stringify(
      {
        stateVersion: 2,
        engine: "v2",
        slug,
        mode: "up",
        assSchema: 2,
        scenarioPath: path.join(root, `${slug}.toml`),
        seed: 7,
        declarationDigest: "d".repeat(64),
        heldAt: now,
        completedAt: now,
        ownsPlatform: false,
        overrides: {},
        declaration: {
          assSchema: 2,
          name: slug,
          seed: 7,
          account: {
            username: "u",
            password: "p",
            namespace: "n",
            pinned: true,
          },
        },
        anchorMs: Date.parse(ANCHOR),
        workers: {},
        perKindCounts: {},
        digests: {},
        rawFrom: {},
        identity: [],
        surface: { apps: 0, totalRequests: 0, daily: [] },
        teardown: [],
      },
      null,
      2,
    ) + "\n",
  );
  return file;
}

// -- up happy path (a full reconcile through the store seam) -----------------

describe("pin: ass up happy path", () => {
  test("up reconciles, exits 0, and records the held-state file contract", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min.toml", MINIMAL_V1_TOML);
    const result = await cliPin(harness, [
      "up",
      "--file",
      "t-min.toml",
      "--anchor",
      ANCHOR,
    ]);
    expect(result.code).toBe(0);
    expect(plain(result.stdout)).toContain("reconciled");
    // The identity really went through the engine's apply loop.
    expect(harness.applied).toEqual(["user:sim-user", "namespace:sim-ns"]);

    const held = readHeld(harness.root, "t-min");
    expect(held["slug"]).toBe("t-min");
    expect(held["mode"]).toBe("up");
    expect(held["stateVersion"]).toBe(2);
    expect(held["seed"]).toBe(42);
    expect(String(held["scenarioPath"])).toMatch(/t-min\.toml$/);
    expect(typeof held["heldAt"]).toBe("string");
    expect(held["completedAt"]).not.toBeNull();
    expect(held["ownsPlatform"]).toBe(true);
    expect(Array.isArray(held["teardown"])).toBe(true);
    expect(held["teardown"]).toEqual([]);
    // Digest = sha256 of the raw declaration text (no overrides).
    expect(held["declarationDigest"]).toBe(
      createHash("sha256").update(MINIMAL_V1_TOML).digest("hex"),
    );
  });
});

// -- declaration gates (default engine) --------------------------------------

describe("pin: declaration gates", () => {
  test("a .yaml file is refused naming the expected format", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "x.yaml", "name: nope\n");
    const result = await cliPin(harness, ["up", "--file", "x.yaml"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("must be a .toml file");
    expect(result.stderr).toContain("TOML-only");
  });

  test("missing file exits 1 with the read error", async () => {
    const harness = makeHarness();
    const result = await cliPin(harness, ["up", "--file", "nope.toml"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot read scenario file");
  });

  test("no assSchema exits 1 pointing at both formats", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "ass-style.toml", 'meta = { id = "X" }\n');
    const result = await cliPin(harness, ["up", "--file", "ass-style.toml"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no assSchema key");
    expect(result.stderr).toContain("ass try");
  });

  test("unsupported assSchema exits 1 naming the supported versions", async () => {
    const harness = makeHarness();
    writeScenario(
      harness.root,
      "future.toml",
      V2_TOML.replace("assSchema = 2", "assSchema = 3"),
    );
    const result = await cliPin(harness, ["up", "--file", "future.toml"]);
    expect(result.code).toBe(1);
    // Default engine wording; the v1 engine's "supports assSchema = 1" is
    // pinned in simulator.test.ts and dies with it.
    expect(result.stderr).toContain("supports assSchema = 1 and 2");
  });
});

// -- assSchema=1 auto-upgrade -------------------------------------------------

describe("pin: assSchema=1 auto-upgrade", () => {
  test("a v1-shaped declaration plans identically to its assSchema=2 form", async () => {
    const v1 = makeHarness();
    const v2 = makeHarness();
    writeScenario(v1.root, "same.toml", V1_SHAPED_TOML);
    writeScenario(v2.root, "same.toml", V2_TOML);
    const argv = ["up", "--file", "same.toml", "--plan", "--anchor", ANCHOR];
    const fromV1 = await cliPin(v1, argv);
    const fromV2 = await cliPin(v2, argv);
    expect(fromV1.code).toBe(0);
    expect(fromV2.code).toBe(0);
    expect(fromV1.stdout).toBe(fromV2.stdout);
    expect(fromV1.stdout).toContain("expansion");
  });
});

// -- --set override grammar (default engine) ---------------------------------

describe("pin: --set overrides", () => {
  test("TOML scalars apply and are repeatable", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "pin.toml", V2_TOML);
    const result = await cliPin(harness, [
      "up",
      "--file",
      "pin.toml",
      "--plan",
      "--anchor",
      ANCHOR,
      "--set",
      "apps.count=13",
      "--set",
      "billing.invoices.count=5",
    ]);
    expect(result.code).toBe(0);
    expect(plain(result.stdout)).toMatch(/13 app\b/);
    expect(plain(result.stdout)).toMatch(/5 invoice\b/);
  });

  test("a quoted TOML string stays a string (schema refuses it for count)", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "pin.toml", V2_TOML);
    const result = await cliPin(harness, [
      "up",
      "--file",
      "pin.toml",
      "--plan",
      "--set",
      'apps.count="13"',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid simulator declaration");
  });

  test("bare words are strings (enum accepts a bare value, refuses a bogus one)", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "pin.toml", V2_TOML);
    const ok = await cliPin(harness, [
      "up",
      "--file",
      "pin.toml",
      "--plan",
      "--anchor",
      ANCHOR,
      "--set",
      "billing.subscription=past_due",
    ]);
    expect(ok.code).toBe(0);
    const bad = await cliPin(harness, [
      "up",
      "--file",
      "pin.toml",
      "--plan",
      "--set",
      "billing.subscription=bogus_state",
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("invalid simulator declaration");
  });

  test("an invalid --set errors without writing state", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "pin.toml", V2_TOML);
    const malformed = await cliPin(harness, [
      "up",
      "--file",
      "pin.toml",
      "--set",
      "nope",
    ]);
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toContain("--set expects");

    const broken = await cliPin(harness, [
      "up",
      "--file",
      "pin.toml",
      "--set",
      "apps.count=-1",
    ]);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain("invalid simulator declaration");
    expect(existsSync(path.join(harness.root, ".ass", "state"))).toBe(false);
    expect(harness.driver.calls).toEqual([]);
  });
});

// -- --plan is a pure read ----------------------------------------------------

describe("pin: --plan writes nothing", () => {
  test("plan prints the expansion, exits 0, and has zero side effects", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "pin.toml", V2_TOML);
    const result = await cliPin(harness, [
      "up",
      "--file",
      "pin.toml",
      "--plan",
      "--anchor",
      ANCHOR,
    ]);
    expect(result.code).toBe(0);
    expect(plain(result.stdout)).toContain("seed: 42");
    expect(plain(result.stdout)).toMatch(/expansion: 1 user/);
    expect(result.stdout).toContain("plan only - nothing was written");
    expect(harness.driver.calls).toEqual([]);
    expect(existsSync(path.join(harness.root, ".ass", "state"))).toBe(false);
  });
});

// -- determinism --------------------------------------------------------------

describe("pin: determinism", () => {
  test("same declaration + seed + anchor => byte-identical plan output", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "pin.toml", V2_TOML);
    const argv = ["up", "--file", "pin.toml", "--plan", "--anchor", ANCHOR];
    const first = await cliPin(harness, argv);
    const second = await cliPin(harness, argv);
    expect(first.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });

  test("a different seed expands a different world", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "a.toml", V2_TOML);
    writeScenario(
      harness.root,
      "b.toml",
      V2_TOML.replace("seed = 42", "seed = 43"),
    );
    const argv = (file: string) => [
      "up",
      "--file",
      file,
      "--plan",
      "--anchor",
      ANCHOR,
    ];
    const a = await cliPin(harness, argv("a.toml"));
    const b = await cliPin(harness, argv("b.toml"));
    const telemetryLine = (text: string): string =>
      text.split("\n").find((line) => line.includes("telemetry:")) ?? "";
    expect(telemetryLine(a.stdout)).not.toBe("");
    expect(telemetryLine(b.stdout)).not.toBe(telemetryLine(a.stdout));
  });

  test("recorded declaration digests are stable across runs, seed-sensitive", async () => {
    const first = makeHarness();
    const second = makeHarness();
    const third = makeHarness();
    writeScenario(first.root, "t-min.toml", MINIMAL_V1_TOML);
    writeScenario(second.root, "t-min.toml", MINIMAL_V1_TOML);
    writeScenario(
      third.root,
      "t-min.toml",
      MINIMAL_V1_TOML.replace("seed = 42", "seed = 43"),
    );
    for (const harness of [first, second, third]) {
      const result = await cliPin(harness, [
        "up",
        "--file",
        "t-min.toml",
        "--anchor",
        ANCHOR,
      ]);
      expect(result.code).toBe(0);
    }
    const digest = (harness: Harness): unknown =>
      readHeld(harness.root, "t-min")["declarationDigest"];
    expect(digest(second)).toBe(digest(first));
    expect(digest(third)).not.toBe(digest(first));
  });
});

// -- status -------------------------------------------------------------------

describe("pin: ass status", () => {
  test("--json with nothing held is the exact empty shape; human says none", async () => {
    const harness = makeHarness();
    const json = await cliPin(harness, ["status", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      held: [],
      corrupt: [],
      platform: { live: false, registry: null },
      seeding: null,
    });
    const human = await cliPin(harness, ["status"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("held scenarios: none");
    expect(human.stdout).toContain("platform: not serving");
  });

  test("--json lists held worlds with the exact key set", async () => {
    // Phase B dropped the v1 half knowingly; the key set and the v2 row
    // survive unchanged, and the engine-held row joins them.
    const harness = makeHarness();
    writeScenario(harness.root, "t-min.toml", MINIMAL_V1_TOML);
    const up = await cliPin(harness, [
      "up",
      "--file",
      "t-min.toml",
      "--anchor",
      ANCHOR,
    ]);
    expect(up.code).toBe(0);
    harness.driver.runDir = null; // platform down: no workspace lookup
    writeV2Ledger(harness.root, "pin-v2");

    const result = await cliPin(harness, ["status", "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      held: Array<Record<string, unknown>>;
    };
    expect(parsed.held.map((held) => held["slug"]).sort()).toEqual([
      "pin-v2",
      "t-min",
    ]);
    for (const held of parsed.held) {
      // `workspace` is additive: present only when the platform is live and
      // the hold names an account - pinned absent here.
      expect(Object.keys(held).sort()).toEqual([
        "ageSeconds",
        "completed",
        "doneEntries",
        "entries",
        "heldAt",
        "ownsPlatform",
        "scenarioPath",
        "seed",
        "slug",
        "totalEntries",
      ]);
    }
    const v2Row = parsed.held.find((held) => held["slug"] === "pin-v2");
    expect(v2Row).toMatchObject({
      seed: 7,
      completed: true,
      ownsPlatform: false,
      entries: {},
      doneEntries: 0,
      totalEntries: 0,
    });
    const engineRow = parsed.held.find((held) => held["slug"] === "t-min");
    expect(engineRow).toMatchObject({
      seed: 42,
      completed: true,
      ownsPlatform: true,
      entries: {},
    });
  });
});

// -- down ---------------------------------------------------------------------

describe("pin: ass down", () => {
  test("a v2 hold with the platform not serving releases and exits 0", async () => {
    const harness = makeHarness();
    writeV2Ledger(harness.root, "pin-v2");
    const result = await cliPin(harness, ["down", "pin-v2"]);
    expect(result.code).toBe(0);
    expect(plain(result.stdout)).toContain("platform is not serving");
    expect(plain(result.stdout)).toContain("releasing the held state");
    expect(existsSync(heldPath(harness.root, "pin-v2"))).toBe(false);
    expect(harness.driver.calls).not.toContain("up");
  });

  test("down with nothing held is a successful no-op with the existing messages", async () => {
    const harness = makeHarness();
    const bare = await cliPin(harness, ["down"]);
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain(
      "nothing is held — no descriptor under .ass/state/",
    );
    const named = await cliPin(harness, ["down", "ghost"]);
    expect(named.code).toBe(0);
    expect(named.stdout).toContain('nothing is held for "ghost"');
    expect(named.stdout).toContain("already released");
  });

  test("down --file only locates the slug: an edited file warns and proceeds", async () => {
    const harness = makeHarness();
    const file = writeScenario(harness.root, "t-min.toml", MINIMAL_V1_TOML);
    const up = await cliPin(harness, [
      "up",
      "--file",
      "t-min.toml",
      "--anchor",
      ANCHOR,
    ]);
    expect(up.code).toBe(0);
    writeFileSync(file, MINIMAL_V1_TOML + 'description = "edited"\n');
    const result = await cliPin(harness, ["down", "--file", "t-min.toml"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("has changed since");
    expect(existsSync(heldPath(harness.root, "t-min"))).toBe(false);
    // The pinned identity is retained; nothing else was held to delete.
    expect(harness.downed).toEqual([]);
  });
});

// -- concurrency lock ---------------------------------------------------------

describe("pin: the up lock", () => {
  test("a live concurrent up refuses with the exact message", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "pin.toml", V2_TOML);
    const lockDir = path.join(harness.root, ".ass", "state");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "up.lock"), String(process.pid));
    const result = await cliPin(harness, ["up", "--file", "pin.toml"]);
    expect(result.code).toBe(1);
    // Byte-pinned: scripts and humans grep for this line.
    expect(result.stderr).toContain("another ass up is already running");
    expect(existsSync(heldPath(harness.root, "pin"))).toBe(false);
  });
});

// -- the two-layer local-only guard -------------------------------------------

describe("pin: local-only guard", () => {
  test("verb entry: a non-local platform env refuses before any write", async () => {
    const harness = makeHarness();
    harness.driver.env["WASMER_REGISTRY"] =
      "https://registry.wasmer.io/graphql";
    harness.driver.runDir = "/fake/run";
    writeScenario(harness.root, "pin.toml", V2_TOML);
    const result = await cliPin(harness, ["up", "--file", "pin.toml"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("WASMER_REGISTRY");
    expect(result.stderr).toContain("no override");
    expect(existsSync(heldPath(harness.root, "pin"))).toBe(false);
  });

  test("client factories: a non-loopback URL refuses at construction", async () => {
    // Layer two of D-K. Mirrors simulator-seeders.test.ts (which imports v1
    // seeders and dies in phase B); the guarded factories survive.
    expect(
      () => new SimulatorBackend("https://registry.wasmer.io/graphql"),
    ).toThrow(GuardRefusalError);
    await expect(
      connectSimulatorPostgres({
        LOCAL_PLATFORM_POSTGRES_URL:
          "postgresql://u:p@db.prod.internal:5432/wapm",
      }),
    ).rejects.toThrow(GuardRefusalError);
  });
});

// -- diff / verify with no platform -------------------------------------------

describe("pin: diff and verify without a platform", () => {
  test("diff prints the expansion only and exits 0", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "pin.toml", V2_TOML);
    const result = await cliPin(harness, ["diff", "--file", "pin.toml"]);
    expect(result.code).toBe(0);
    expect(plain(result.stdout)).toContain("no live local platform");
    expect(plain(result.stdout)).toContain(
      "printing the expansion only; nothing was observed",
    );
    expect(plain(result.stdout)).toMatch(/expansion: 1 user/);
    expect(harness.driver.calls).not.toContain("up");
  });

  test("verify errors: there is no platform to verify against (exit 4)", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "pin.toml", V2_TOML);
    const result = await cliPin(harness, ["verify", "--file", "pin.toml"]);
    expect(result.code).toBe(4);
    expect(plain(result.stdout + result.stderr)).toContain(
      "there is no platform to verify against",
    );
    expect(harness.driver.calls).not.toContain("up");
  });
});

// -- held-state file formats --------------------------------------------------

describe("pin: held-state file formats", () => {
  test("a stateVersion: 2 ledger is what routes down to the v2 engine", async () => {
    const harness = makeHarness();
    writeV2Ledger(harness.root, "pin-v2");
    const held = readHeld(harness.root, "pin-v2");
    // The v2 on-disk marker set (superset of the v1 descriptor, so status
    // reads both): these keys are the inspection contract.
    for (const key of [
      "stateVersion",
      "slug",
      "mode",
      "seed",
      "declarationDigest",
      "heldAt",
      "completedAt",
      "ownsPlatform",
      "teardown",
    ]) {
      expect(key in held).toBe(true);
    }
    expect(held["stateVersion"]).toBe(2);
    expect(held["mode"]).toBe("up");
    expect(held["teardown"]).toEqual([]);
    // Routed to v2: released, not replayed (no fake teardown kind runs).
    const result = await cliPin(harness, ["down", "pin-v2"]);
    expect(result.code).toBe(0);
    expect(harness.downed).toEqual([]);
  });
});
