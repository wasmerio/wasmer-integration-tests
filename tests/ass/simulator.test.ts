// Simulator lifecycle and foundations: declaration gating, the seeded
// PRNG, the two-layer local-only guard, ledger persistence/corruption
// semantics, `--set` override loading, and the lifecycle contract rows
// (platform reuse, converge-on-rerun, declared change, teardown resume,
// corrupt state, secrets-free ledger) driven through the real CLI with a
// fake platform driver and fake store adapters (the SimulatorDeps seam).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli, type CliOptions } from "../../ass/cli";
import { makeRoot } from "./helpers";
import {
  loadDeclarationFile,
  parseDeclaration,
  parseDurationMs,
  parseOverride,
  parseSizeBytes,
  SimulatorLoadError,
} from "../../ass/simulator/scenario";
import {
  assertLocalOnly,
  guardedUrl,
  GuardRefusalError,
  isLoopbackHost,
  redactUrl,
} from "../../ass/simulator/guard";
import {
  CorruptStateError,
  digestDeclaration,
  ledgerPath,
  listLedgers,
  readLedger,
  writeLedger,
  type LedgerFile,
} from "../../ass/simulator/ledger";
import { seededRandom } from "../../ass/simulator/random";
import { appNames } from "../../ass/simulator/names";
import {
  FIXTURE_NAMES,
  fixturePackage,
  writeFixtureApp,
} from "../../ass/simulator/fixtures";
import { SimulatorBackend } from "../../ass/simulator/clients/graphql";
import { connectSimulatorPostgres } from "../../ass/simulator/clients/postgres";
import type { PlatformDriver } from "../../ass/fixtures/localPlatform";
import type { Resource } from "../../ass/simulator/model";

const SECRET_TOKEN = "wap_super_secret_token_value";
const PG_PASSWORD = "pg_secret_password";
const ANCHOR = "2026-08-18T20:00:00Z";

function localEnv(): Record<string, string> {
  return {
    WASMER_REGISTRY: "http://localhost:18000/graphql",
    WASMER_TOKEN: SECRET_TOKEN,
    WASMER_NAMESPACE: "t-ns",
    LOCAL_PLATFORM_POSTGRES_URL: `postgresql://postgres:${PG_PASSWORD}@localhost:15432/wapm`,
    LOCAL_PLATFORM_CLICKHOUSE_URL: "http://localhost:18123",
  };
}

const MINIMAL_TOML = [
  "assSchema = 1",
  'name = "t-min"',
  "seed = 42",
  'account = { username = "sim-user", password = "sim-pass", namespace = "sim-ns" }',
  "",
].join("\n");

class FakeSimDriver implements PlatformDriver {
  readonly repoDir: string;
  runDir: string | null = null;
  env: Record<string, string>;
  calls: string[] = [];
  /** Containers up but backend not answering (the stale-symlink trap). */
  backendDead = false;
  failUp = false;
  failDown: string | null = null;

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
    if (this.failUp) {
      throw new Error("simulated boot failure");
    }
    this.runDir = path.join(this.repoDir, "fake-run");
  }
  async down(): Promise<string | null> {
    this.calls.push("down");
    if (this.failDown !== null) {
      return this.failDown;
    }
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

type SimDeps = NonNullable<CliOptions["simulatorDeps"]>;
type FakeAdapter = NonNullable<SimDeps["adapters"]>[number];

interface Harness {
  root: string;
  driver: FakeSimDriver;
  /** The in-memory "platform": what the fake adapters observe. */
  store: Map<string, Resource>;
  applied: string[];
  downed: string[];
  failApplyKind?: string;
  simulatorDeps: SimDeps;
}

/** A stateful fake adapter: observe reads the store, apply writes it. The
 * reconciler's own plan/diff/scheduler machinery runs for real. */
function fakeAdapter(harness: Harness, kind: FakeAdapter["kind"]): FakeAdapter {
  const keyOf = (resource: Resource): string =>
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
        if (harness.failApplyKind === kind) {
          return { id: op.id, ok: false, error: `simulated ${kind} failure` };
        }
        if (op.type === "delete") {
          const observed = op.observed as Resource;
          harness.store.delete(keyOf(observed));
          harness.downed.push(keyOf(observed));
        } else {
          const desired = op.desired as Resource;
          harness.store.set(keyOf(desired), desired);
          harness.applied.push(`${op.type}:${keyOf(desired)}`);
        }
        return { id: op.id, ok: true };
      });
    },
  };
}

function makeHarness(): Harness {
  const root = makeRoot();
  const driver = new FakeSimDriver(root);
  const harness: Harness = {
    root,
    driver,
    store: new Map(),
    applied: [],
    downed: [],
    simulatorDeps: undefined as unknown as SimDeps,
  };
  harness.simulatorDeps = {
    driver,
    fetchImpl: async () => {
      if (driver.runDir === null || driver.backendDead) {
        throw new Error("ECONNREFUSED");
      }
      return { status: 400 };
    },
    adapters: (["user", "namespace", "app", "app-version"] as const).map(
      (kind) => fakeAdapter(harness, kind),
    ),
    now: () => 1_755_000_000_000,
  };
  return harness;
}

async function cliSim(
  harness: Harness,
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd: harness.root,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    color: false,
    simulatorDeps: harness.simulatorDeps,
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

function writeScenario(root: string, name: string, toml: string): string {
  const file = path.join(root, `${name}.toml`);
  writeFileSync(file, toml);
  return file;
}

/** The reporter frames output; assertions read words, not layout. */
function plain(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\S*\s*│\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

// -- schema -----------------------------------------------------------------

describe("simulator declaration schema", () => {
  test("parses the minimal assSchema=1 declaration, upgraded with defaults", () => {
    const declaration = parseDeclaration(MINIMAL_TOML, "x.toml");
    expect(declaration.assSchema).toBe(2);
    expect(declaration.name).toBe("t-min");
    expect(declaration.seed).toBe(42);
    expect(declaration.apps).toBeUndefined();
  });

  test("full spec §4 example shape parses (rawWindow → precision.raw)", () => {
    const declaration = parseDeclaration(
      [
        "assSchema = 1",
        'name = "local-dev"',
        "seed = 1337",
        'account = { username = "u", password = "p", namespace = "n" }',
        "[apps]",
        "count = 12",
        'fixture = "static-site"',
        "domains = { custom = 4 }",
        'disks = { attached = 3, sizes = ["1G", "10G"] }',
        "deployments = { perApp = 20, failed = 2 }",
        "[telemetry]",
        'history = "90d"',
        'rawWindow = "24h"',
        'latency = { p50 = "45ms", p95 = "300ms", p99 = "900ms" }',
        "[telemetry.rps]",
        "base = 40",
        'spikes = [{ at = "-3d", multiplier = 12, duration = "2h" }]',
        "[telemetry.errorRate]",
        "base = 0.002",
        'bursts = [{ at = "-1d", rate = 0.15, duration = "30m" }]',
        "[telemetry.resources]",
        "cpuMillisPerRequest = { mean = 12, stddev = 4 }",
        'memoryBytes = { mean = "128Mi", stddev = "32Mi" }',
        "[billing]",
        'plan = "scale"',
        'subscription = "active"',
        "invoices = { count = 14, failed = 0 }",
        "entitlements = { computeConsumed = 0.8 }",
      ].join("\n"),
      "x.toml",
    );
    expect(declaration.telemetry?.rps.spikes).toHaveLength(1);
    expect(declaration.telemetry?.precision.raw).toBe("24h");
    expect(declaration.billing?.subscription).toBe("active");
  });

  test("a file without assSchema is refused pointing at both formats", () => {
    const assScenario =
      'meta = { id = "WAX-1" }\nfixtures = {}\nload = { profiles = {} }\n';
    expect(() => parseDeclaration(assScenario, "scenario.toml")).toThrow(
      /no assSchema key.*ass try.*ass run|assSchema/s,
    );
  });

  test("an unknown assSchema names the supported versions", () => {
    expect(() =>
      parseDeclaration('assSchema = 3\nname = "x"\n', "x.toml"),
    ).toThrow(/supports assSchema = 1 and 2/);
  });

  test("verdict is impossible by construction (strict object)", () => {
    expect(() =>
      parseDeclaration(MINIMAL_TOML + "verdict = { probe = {} }\n", "x.toml"),
    ).toThrow(SimulatorLoadError);
  });

  test("invalid TOML is a load error naming the path", () => {
    expect(() => parseDeclaration("= [broken", "bad.toml")).toThrow(
      /bad\.toml: invalid TOML/,
    );
  });

  test("duration and size grammars", () => {
    expect(parseDurationMs("90d")).toBe(90 * 86_400_000);
    expect(parseDurationMs("-3d")).toBe(-3 * 86_400_000);
    expect(parseDurationMs("45ms")).toBe(45);
    expect(parseSizeBytes("128Mi")).toBe(128 * 1024 * 1024);
    expect(parseSizeBytes("1G")).toBe(1_000_000_000);
    expect(() => parseDurationMs("90x")).toThrow(/not a duration/);
  });

  test("schema accepts a fixture mix, refuses unknown names and empty mixes", () => {
    const base = (fixture: string): string =>
      [
        "assSchema = 1",
        'name = "t-mix"',
        'account = { username = "u", password = "p", namespace = "n" }',
        "[apps]",
        "count = 4",
        `fixture = ${fixture}`,
      ].join("\n");
    const parsed = parseDeclaration(
      base("{ static-site = 10, php = 1, python = 3 }"),
      "t.toml",
    );
    expect(typeof parsed.apps?.fixture).toBe("object");
    expect(() => parseDeclaration(base("{ cobol = 1 }"), "t.toml")).toThrow();
    expect(() => parseDeclaration(base("{}"), "t.toml")).toThrow();
    expect(() => parseDeclaration(base('"cobol"'), "t.toml")).toThrow();
  });

  test("account.pinned defaults true; e2e-style opt-out parses", () => {
    const toml = (extra = ""): string =>
      [
        "assSchema = 1",
        'name = "t-pin"',
        `account = { username = "u", password = "p", namespace = "n"${extra} }`,
      ].join("\n");
    expect(parseDeclaration(toml(), "t.toml").account.pinned).toBe(true);
    expect(
      parseDeclaration(toml(", pinned = false"), "t.toml").account.pinned,
    ).toBe(false);
  });
});

// -- --set overrides at the function level ----------------------------------

describe("--set overrides (loader level)", () => {
  const BASE_TOML = [
    "assSchema = 1",
    'name = "t-delta"',
    "seed = 1337",
    'account = { username = "u", password = "p", namespace = "n" }',
    "apps = { count = 4 }",
    "[telemetry]",
    'history = "2d"',
    'rawWindow = "3h"',
    "[telemetry.rps]",
    "base = 2",
  ].join("\n");

  function writeOverrideScenario(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "sim-set-"));
    const file = path.join(dir, "t-delta.toml");
    writeFileSync(file, BASE_TOML);
    return file;
  }

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
    const file = writeOverrideScenario();
    const plainLoad = loadDeclarationFile(file);
    const tweaked = loadDeclarationFile(file, ["apps.count=13"]);
    expect(plainLoad.declaration.apps?.count).toBe(4);
    expect(tweaked.declaration.apps?.count).toBe(13);
    expect(tweaked.overrides).toEqual({ "apps.count": "13" });
    expect(digestDeclaration(tweaked.raw)).not.toBe(
      digestDeclaration(plainLoad.raw),
    );
    // Same overrides ⇒ same digest (a --set rerun is recognizable).
    const again = loadDeclarationFile(file, ["apps.count=13"]);
    expect(digestDeclaration(again.raw)).toBe(digestDeclaration(tweaked.raw));
  });

  test("an override that breaks the schema fails with schema errors", () => {
    const file = writeOverrideScenario();
    expect(() => loadDeclarationFile(file, ["apps.count=-1"])).toThrow(
      /invalid simulator declaration/,
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

// -- PRNG -------------------------------------------------------------------

describe("seeded PRNG", () => {
  test("same seed, same stream; forks are independent", () => {
    const a = seededRandom(1337);
    const b = seededRandom(1337);
    const seqA = [a.next(), a.int(0, 100), a.next()];
    const seqB = [b.next(), b.int(0, 100), b.next()];
    expect(seqA).toEqual(seqB);

    const forked = seededRandom(1337).fork("apps");
    const forkedAgain = seededRandom(1337).fork("apps");
    expect(forked.next()).toBe(forkedAgain.next());
    expect(seededRandom(1337).fork("apps").next()).not.toBe(
      seededRandom(1337).fork("telemetry").next(),
    );
  });
});

// -- deterministic app names ------------------------------------------------

describe("deterministic app names", () => {
  test("same seed, same names; distinct and index-stable", () => {
    const a = appNames(seededRandom(1337), 200);
    const b = appNames(seededRandom(1337), 200);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(200);
    // Growing the count never renames earlier apps (stable prefixes).
    expect(appNames(seededRandom(1337), 5)).toEqual(a.slice(0, 5));
  });

  test("different seeds diverge", () => {
    expect(appNames(seededRandom(1), 5)).not.toEqual(
      appNames(seededRandom(2), 5),
    );
  });
});

// -- app fixtures -----------------------------------------------------------

describe("app fixtures", () => {
  test("every registered fixture materializes a deployable app dir", () => {
    for (const fixture of FIXTURE_NAMES) {
      const dir = mkdtempSync(path.join(tmpdir(), "sim-fixture-"));
      writeFixtureApp(fixture, dir, "test-app", "test-ns");
      const toml = readFileSync(path.join(dir, "wasmer.toml"), "utf8");
      expect(toml).toContain(fixturePackage(fixture).split("/")[0]);
      expect(readFileSync(path.join(dir, "app.yaml"), "utf8")).toContain(
        "name: test-app",
      );
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// -- guard ------------------------------------------------------------------

describe("local-only guard", () => {
  test("loopback hosts pass", () => {
    for (const host of ["localhost", "127.0.0.1", "127.5.4.3", "::1"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    expect(() => assertLocalOnly(localEnv())).not.toThrow();
  });

  test("non-loopback resolved endpoint refuses, naming variable and host", () => {
    const env = {
      ...localEnv(),
      WASMER_REGISTRY: "https://registry.wasmer.io/graphql",
    };
    expect(() => assertLocalOnly(env)).toThrow(GuardRefusalError);
    expect(() => assertLocalOnly(env)).toThrow(
      /WASMER_REGISTRY.*registry\.wasmer\.io.*no override/s,
    );
  });

  test("a missing guarded variable is a refusal, not a pass", () => {
    const env = localEnv();
    delete (env as Record<string, string | undefined>)[
      "LOCAL_PLATFORM_CLICKHOUSE_URL"
    ];
    expect(() => assertLocalOnly(env)).toThrow(
      /LOCAL_PLATFORM_CLICKHOUSE_URL is missing/,
    );
  });

  test("credentials are redacted from refusal messages", () => {
    expect(
      redactUrl("postgresql://u:hunter2@db.prod.example/wapm"),
    ).not.toContain("hunter2");
    try {
      guardedUrl(
        "LOCAL_PLATFORM_POSTGRES_URL",
        "postgresql://u:hunter2@db.prod.example/wapm",
      );
      throw new Error("should have refused");
    } catch (err) {
      expect(String(err)).not.toContain("hunter2");
      expect(String(err)).toContain("db.prod.example");
    }
  });

  test("unparseable URL cannot be verified, so it refuses", () => {
    expect(() => guardedUrl("X", "not a url")).toThrow(/cannot be verified/);
  });

  test("client factories refuse non-loopback targets at construction", async () => {
    expect(
      () => new SimulatorBackend("https://registry.wasmer.io/graphql"),
    ).toThrow(GuardRefusalError);
    await expect(
      connectSimulatorPostgres({
        LOCAL_PLATFORM_POSTGRES_URL: "postgresql://u:p@10.0.0.5:5432/wapm",
      }),
    ).rejects.toThrow(/not loopback/);
  });

  test("no override mechanism exists: guard.ts reads no env flags", () => {
    const source = readFileSync(
      path.join(__dirname, "../../ass/simulator/guard.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/process\.env/);
  });
});

// -- unseeded randomness ban ------------------------------------------------

describe("unseeded randomness ban (spec §4.1)", () => {
  test("no Math.random anywhere under ass/simulator/", () => {
    const root = path.join(__dirname, "../../ass/simulator");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".ts")) {
          files.push(full);
        }
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      expect({
        file,
        hasMathRandom: /Math\.random/.test(readFileSync(file, "utf8")),
      }).toEqual({ file, hasMathRandom: false });
    }
  });
});

// -- ledger persistence ------------------------------------------------------

describe("ledger persistence", () => {
  const base: LedgerFile = {
    stateVersion: 2,
    slug: "t-ledger",
    mode: "up",
    assSchema: 2,
    scenarioPath: "/x/t.toml",
    seed: 7,
    declarationDigest: "abc",
    heldAt: "2026-08-14T00:00:00.000Z",
    completedAt: null,
    ownsPlatform: false,
    overrides: {},
    declaration: parseDeclaration(MINIMAL_TOML, "t.toml"),
    anchorMs: Date.parse(ANCHOR),
    workers: {},
    perKindCounts: {},
    digests: {},
    rawFrom: {},
    identity: [],
    surface: { apps: 0, totalRequests: 0, daily: [] },
    teardown: [],
  };

  test("write/read roundtrip, atomically (no tmp residue)", () => {
    const root = makeRoot();
    const file = writeLedger(root, base);
    expect(readLedger(root, "t-ledger")).toEqual(base);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(readFileSync(file, "utf8")).toContain("\n  ");
  });

  test("absent reads as null; corrupt throws instead of reading absent", () => {
    const root = makeRoot();
    expect(readLedger(root, "nope")).toBeNull();
    mkdirSync(path.dirname(ledgerPath(root, "bad")), { recursive: true });
    writeFileSync(ledgerPath(root, "bad"), "{ not json");
    expect(() => readLedger(root, "bad")).toThrow(CorruptStateError);
    const listing = listLedgers(root);
    expect(listing.corrupt).toHaveLength(1);
    expect(listing.ledgers).toHaveLength(0);
  });
});

// -- lifecycle through the CLI ---------------------------------------------

describe("ass up", () => {
  test("row 1: fresh up boots the platform, holds it, ownsPlatform: true", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min", MINIMAL_TOML);
    const result = await cliSim(harness, [
      "up",
      "--file",
      "t-min.toml",
      "--anchor",
      ANCHOR,
    ]);
    expect(result.code).toBe(0);
    expect(harness.driver.calls).toContain("up");
    expect(harness.driver.runDir).not.toBeNull();
    const ledger = readLedger(harness.root, "t-min");
    expect(ledger?.ownsPlatform).toBe(true);
    expect(ledger?.completedAt).not.toBeNull();
    expect(ledger?.teardown).toEqual([]);
    // The pinned identity was created through the fake adapters.
    expect(harness.applied).toEqual([
      "create:user:sim-user",
      "create:namespace:sim-ns",
    ]);
    expect(plain(result.stdout)).toContain("reconciled");
  });

  test("row 2: reuses a running platform without rebooting", async () => {
    const harness = makeHarness();
    harness.driver.runDir = "/fake/run";
    writeScenario(harness.root, "t-min", MINIMAL_TOML);
    const result = await cliSim(harness, [
      "up",
      "--file",
      "t-min.toml",
      "--anchor",
      ANCHOR,
    ]);
    expect(result.code).toBe(0);
    expect(harness.driver.calls).not.toContain("up");
    expect(harness.driver.calls).not.toContain("down");
    expect(readLedger(harness.root, "t-min")?.ownsPlatform).toBe(false);
  });

  test("row 3: unchanged re-run converges with zero operations", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min", MINIMAL_TOML);
    await cliSim(harness, ["up", "--file", "t-min.toml", "--anchor", ANCHOR]);
    harness.applied = [];
    const rerun = await cliSim(harness, [
      "up",
      "--file",
      "t-min.toml",
      "--anchor",
      ANCHOR,
    ]);
    expect(rerun.code).toBe(0);
    expect(plain(rerun.stdout)).toContain("converged");
    expect(harness.applied).toEqual([]);
  });

  test("row 4: a declared change reconciles the delta, not the world", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min", MINIMAL_TOML);
    await cliSim(harness, ["up", "--file", "t-min.toml", "--anchor", ANCHOR]);
    harness.applied = [];
    const grown = await cliSim(harness, [
      "up",
      "--file",
      "t-min.toml",
      "--anchor",
      ANCHOR,
      "--set",
      "apps.count=1",
    ]);
    expect(grown.code).toBe(0);
    // Identity converged (kept), only the app axis was created.
    expect(
      harness.applied.every((entry) => entry.startsWith("create:app")),
    ).toBe(true);
    expect(harness.applied.length).toBeGreaterThan(0);
    const ledger = readLedger(harness.root, "t-min");
    expect(ledger?.overrides).toEqual({ "apps.count": "1" });
  });

  test("row 8: non-local target refuses before any write", async () => {
    const harness = makeHarness();
    harness.driver.env["WASMER_REGISTRY"] =
      "https://registry.wasmer.io/graphql";
    harness.driver.runDir = "/fake/run";
    writeScenario(harness.root, "t-min", MINIMAL_TOML);
    const result = await cliSim(harness, ["up", "--file", "t-min.toml"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("WASMER_REGISTRY");
    expect(harness.applied).toEqual([]);
    expect(listLedgers(harness.root).ledgers).toHaveLength(0);
  });

  test("platform boot failure exits 4 with nothing held", async () => {
    const harness = makeHarness();
    harness.driver.failUp = true;
    writeScenario(harness.root, "t-min", MINIMAL_TOML);
    const result = await cliSim(harness, ["up", "--file", "t-min.toml"]);
    expect(result.code).toBe(4);
    expect(plain(result.stdout + result.stderr)).toContain(
      "platform boot failed",
    );
    expect(listLedgers(harness.root).ledgers).toHaveLength(0);
  });

  test("a corrupt ledger for the slug refuses instead of reading absent", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min", MINIMAL_TOML);
    mkdirSync(path.dirname(ledgerPath(harness.root, "t-min")), {
      recursive: true,
    });
    writeFileSync(ledgerPath(harness.root, "t-min"), "{ nope");
    const result = await cliSim(harness, ["up", "--file", "t-min.toml"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("corrupt");
    expect(harness.applied).toEqual([]);
  });

  test("a dead lock holder is taken over instead of wedging the next run", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min", MINIMAL_TOML);
    const lockDir = path.join(harness.root, ".ass", "state");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "up.lock"), "999999999");
    const retry = await cliSim(harness, [
      "up",
      "--file",
      "t-min.toml",
      "--anchor",
      ANCHOR,
    ]);
    expect(retry.code).toBe(0);
  });

  test("AC-6: the ledger never contains token or password material", async () => {
    const harness = makeHarness();
    writeScenario(
      harness.root,
      "t-full",
      MINIMAL_TOML.replace('name = "t-min"', 'name = "t-full"') +
        "[apps]\ncount = 2\n",
    );
    const result = await cliSim(harness, [
      "up",
      "--file",
      "t-full.toml",
      "--anchor",
      ANCHOR,
    ]);
    expect(result.code).toBe(0);
    const raw = readFileSync(ledgerPath(harness.root, "t-full"), "utf8");
    expect(raw).not.toContain(SECRET_TOKEN);
    expect(raw).not.toContain(PG_PASSWORD);
  });
});

describe("ass down", () => {
  const APPS_TOML =
    MINIMAL_TOML.replace('name = "t-min"', 'name = "t-full"') +
    "[apps]\ncount = 1\n";

  test("row 5: down reconciles to the empty set and releases the ledger", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-full", APPS_TOML);
    await cliSim(harness, ["up", "--file", "t-full.toml", "--anchor", ANCHOR]);
    expect(harness.store.size).toBeGreaterThan(2);

    const result = await cliSim(harness, ["down", "--file", "t-full.toml"]);
    expect(result.code).toBe(0);
    // The pinned identity is retained; the app axis is deleted.
    expect(
      harness.downed.every(
        (entry) => entry.startsWith("app:") || entry.startsWith("app-version:"),
      ),
    ).toBe(true);
    expect(harness.downed.length).toBeGreaterThan(0);
    expect(
      [...harness.store.keys()].every(
        (key) => key.startsWith("user:") || key.startsWith("namespace:"),
      ),
    ).toBe(true);
    expect(readLedger(harness.root, "t-full")).toBeNull();
  });

  test("row 6: a failed delete keeps the ledger; re-run converges", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-full", APPS_TOML);
    await cliSim(harness, ["up", "--file", "t-full.toml", "--anchor", ANCHOR]);

    harness.failApplyKind = "app";
    const first = await cliSim(harness, ["down", "t-full"]);
    expect(first.code).toBe(4);
    expect(plain(first.stdout + first.stderr)).toContain(
      'the hold for "t-full" is kept',
    );
    expect(readLedger(harness.root, "t-full")).not.toBeNull();

    harness.failApplyKind = undefined;
    const second = await cliSim(harness, ["down", "t-full"]);
    expect(second.code).toBe(0);
    expect(readLedger(harness.root, "t-full")).toBeNull();
    expect(
      [...harness.store.keys()].every((key) => !key.startsWith("app")),
    ).toBe(true);
  });

  test("row 7: platform gone ⇒ fast release without touching stores", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min", MINIMAL_TOML);
    await cliSim(harness, ["up", "--file", "t-min.toml", "--anchor", ANCHOR]);
    // Platform dies externally (compose down; volumes gone), symlink stays.
    harness.driver.backendDead = true;
    harness.downed = [];
    const result = await cliSim(harness, ["down", "t-min"]);
    expect(result.code).toBe(0);
    expect(plain(result.stdout)).toContain("platform is not serving");
    expect(harness.downed).toEqual([]);
    expect(readLedger(harness.root, "t-min")).toBeNull();
  });

  test("bare down with several holds refuses, naming them", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min", MINIMAL_TOML);
    writeScenario(
      harness.root,
      "t-other",
      MINIMAL_TOML.replace('name = "t-min"', 'name = "t-other"'),
    );
    await cliSim(harness, ["up", "--file", "t-min.toml", "--anchor", ANCHOR]);
    await cliSim(harness, ["up", "--file", "t-other.toml", "--anchor", ANCHOR]);
    const result = await cliSim(harness, ["down"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("multiple scenarios are held");
    expect(result.stderr).toContain("t-min");
    expect(result.stderr).toContain("t-other");
  });

  test("corrupt ledger is reported, never treated as absent", async () => {
    const harness = makeHarness();
    mkdirSync(path.dirname(ledgerPath(harness.root, "bad")), {
      recursive: true,
    });
    writeFileSync(ledgerPath(harness.root, "bad"), "{ nope");
    const result = await cliSim(harness, ["down", "bad"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("corrupt");
  });
});

describe("ass status", () => {
  test("row 10: --json is stable and exits 0 with and without held state", async () => {
    const harness = makeHarness();
    const empty = await cliSim(harness, ["status", "--json"]);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual({
      held: [],
      corrupt: [],
      platform: { live: false, registry: null },
      seeding: null,
    });

    writeScenario(harness.root, "t-min", MINIMAL_TOML);
    await cliSim(harness, ["up", "--file", "t-min.toml", "--anchor", ANCHOR]);
    const result = await cliSim(harness, ["status", "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.platform).toEqual({
      live: true,
      registry: "http://localhost:18000/graphql",
    });
    expect(parsed.held).toHaveLength(1);
    expect(parsed.held[0]).toMatchObject({
      slug: "t-min",
      seed: 42,
      completed: true,
      ownsPlatform: true,
      entries: {},
      doneEntries: 0,
      totalEntries: 0,
    });
    expect(typeof parsed.held[0].ageSeconds).toBe("number");
  });

  test("human output covers held state and platform liveness", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min", MINIMAL_TOML);
    await cliSim(harness, ["up", "--file", "t-min.toml", "--anchor", ANCHOR]);
    const result = await cliSim(harness, ["status"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("held: t-min (seed 42");
    expect(result.stdout).toContain("platform: serving");
  });

  test("corrupt held-state files are listed, not hidden", async () => {
    const harness = makeHarness();
    mkdirSync(path.dirname(ledgerPath(harness.root, "bad")), {
      recursive: true,
    });
    writeFileSync(ledgerPath(harness.root, "bad"), "{ nope");
    const result = await cliSim(harness, ["status", "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.corrupt).toHaveLength(1);
    expect(parsed.held).toHaveLength(0);
  });

  test("existing verbs are untouched by the simulator commands (help still routes)", async () => {
    const harness = makeHarness();
    const result = await cliSim(harness, ["list"]);
    expect(result.code).toBe(0);
  });
});

// The concurrency-lock refusal and the local-only refusal at the CLI seam
// are byte-pinned in simulator-pin.test.ts.
