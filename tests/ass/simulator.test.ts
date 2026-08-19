// Phase 1 of the business simulator (up/down/status + held-state
// descriptors): declaration gating, the local-only guard, descriptor
// persistence/corruption semantics, and the full lifecycle contract rows
// driven through the real CLI with a fake platform driver.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { runCli, type CliOptions } from "../../ass/cli";
import { makeRoot } from "./helpers";
import {
  parseDeclaration,
  parseDurationMs,
  parseSizeBytes,
  SimulatorLoadError,
} from "../../ass/simulator/schema";
import {
  assertLocalOnly,
  guardedUrl,
  GuardRefusalError,
  isLoopbackHost,
  redactUrl,
} from "../../ass/simulator/guard";
import {
  CorruptDescriptorError,
  heldFile,
  listHeldDescriptors,
  readHeldDescriptor,
  writeHeldDescriptor,
  type HeldDescriptor,
} from "../../ass/simulator/descriptor";
import { seededRandom } from "../../ass/simulator/random";
import type { PlatformDriver } from "../../ass/fixtures/localPlatform";
import type { Seeder, TeardownKind } from "../../ass/simulator/registry";

const SECRET_TOKEN = "wap_super_secret_token_value";
const PG_PASSWORD = "pg_secret_password";

function localEnv(): Record<string, string> {
  return {
    WASMER_REGISTRY: "http://localhost:18000/graphql",
    WASMER_TOKEN: SECRET_TOKEN,
    WASMER_NAMESPACE: "t-ns",
    LOCAL_PLATFORM_POSTGRES_URL: `postgresql://postgres:${PG_PASSWORD}@localhost:15432/wapm`,
    LOCAL_PLATFORM_CLICKHOUSE_URL: "http://localhost:18123",
  };
}

const MINIMAL_YAML = [
  "assSchema: 1",
  "name: t-min",
  "seed: 42",
  "account:",
  "  username: sim-user",
  "  password: sim-pass",
  "  namespace: sim-ns",
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

interface Harness {
  root: string;
  driver: FakeSimDriver;
  applied: string[];
  downed: string[];
  failApply?: string;
  failDownKind?: string;
  simulatorDeps: NonNullable<CliOptions["simulatorDeps"]>;
}

function makeHarness(): Harness {
  const root = makeRoot();
  const driver = new FakeSimDriver(root);
  const harness: Harness = {
    root,
    driver,
    applied: [],
    downed: [],
    simulatorDeps: undefined as unknown as NonNullable<
      CliOptions["simulatorDeps"]
    >,
  };
  const accountSeeder: Seeder = {
    block: "account",
    plan: (declaration) => [
      `account: ${declaration.account.username} in ${declaration.account.namespace}`,
    ],
    apply: async (declaration, _ctx, emit) => {
      if (harness.failApply === "account") {
        throw new Error("simulated account failure");
      }
      harness.applied.push("account");
      emit({
        kind: "fake-account",
        username: declaration.account.username,
      });
    },
  };
  const appsSeeder: Seeder = {
    block: "apps",
    plan: (declaration) => [`apps: ${declaration.apps?.count ?? 0}`],
    apply: async (declaration, _ctx, emit) => {
      harness.applied.push("apps-1");
      emit({ kind: "fake-apps", names: ["a-1"] });
      if (harness.failApply === "apps") {
        throw new Error("simulated deploy failure");
      }
      harness.applied.push("apps-2");
      emit({ kind: "fake-apps", names: ["a-2"] });
    },
  };
  const fakeKind = (kind: string): TeardownKind => ({
    kind,
    down: async (entry) => {
      if (harness.failDownKind === kind) {
        return [`${kind}: simulated teardown failure`];
      }
      harness.downed.push(
        `${kind}:${JSON.stringify(entry["names"] ?? entry["username"])}`,
      );
      return [];
    },
  });
  const localPlatformKind: TeardownKind = {
    kind: "local-platform",
    down: async (_entry, ctx) => {
      const error = await ctx.driver.down();
      return error === null ? [] : [error];
    },
  };
  harness.simulatorDeps = {
    driver,
    fetchImpl: async () => {
      if (driver.runDir === null || driver.backendDead) {
        throw new Error("ECONNREFUSED");
      }
      return { status: 400 };
    },
    seeders: [accountSeeder, appsSeeder],
    teardownKinds: [
      fakeKind("fake-account"),
      fakeKind("fake-apps"),
      localPlatformKind,
    ],
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
  // These rows are the v1 engine's contract (descriptor entries, replayed
  // teardown, the fake platform driver). v2 is the CLI default, so the
  // engine is pinned here rather than left to it.
  const pinned =
    argv[0] === "up" || argv[0] === "down" ? [...argv, "--engine", "v1"] : argv;
  const code = await runCli(pinned, {
    cwd: harness.root,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    color: false,
    simulatorDeps: harness.simulatorDeps,
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

function writeScenario(root: string, name: string, yaml: string): string {
  const file = path.join(root, `${name}.yaml`);
  writeFileSync(file, yaml);
  return file;
}

// -- schema -----------------------------------------------------------------

describe("simulator declaration schema", () => {
  test("parses the minimal declaration with defaults applied", () => {
    const declaration = parseDeclaration(MINIMAL_YAML, "x.yaml");
    expect(declaration.name).toBe("t-min");
    expect(declaration.seed).toBe(42);
    expect(declaration.apps).toBeUndefined();
  });

  test("full spec §4 example shape parses", () => {
    const declaration = parseDeclaration(
      [
        "assSchema: 1",
        "name: local-dev",
        "seed: 1337",
        "account: { username: u, password: p, namespace: n }",
        "apps:",
        "  count: 12",
        "  fixture: static-site",
        "  domains: { custom: 4 }",
        "  disks: { attached: 3, sizes: [1G, 10G] }",
        "  deployments: { perApp: 20, failed: 2 }",
        "telemetry:",
        "  history: 90d",
        "  rps:",
        "    base: 40",
        "    spikes:",
        "      - { at: -3d, multiplier: 12, duration: 2h }",
        "  errorRate:",
        "    base: 0.002",
        "    bursts:",
        "      - { at: -1d, rate: 0.15, duration: 30m }",
        "  latency: { p50: 45ms, p95: 300ms, p99: 900ms }",
        "  resources:",
        "    cpuMillisPerRequest: { mean: 12, stddev: 4 }",
        "    memoryBytes: { mean: 128Mi, stddev: 32Mi }",
        "billing:",
        "  plan: scale",
        "  subscription: active",
        "  invoices: { count: 14, failed: 0 }",
        "  entitlements: { computeConsumed: 0.8 }",
      ].join("\n"),
      "x.yaml",
    );
    expect(declaration.telemetry?.rps.spikes).toHaveLength(1);
    expect(declaration.billing?.subscription).toBe("active");
  });

  test("a file without assSchema is refused pointing at both formats", () => {
    const assScenario =
      "meta:\n  id: WAX-1\nfixtures: {}\nload:\n  profiles: {}\n";
    expect(() => parseDeclaration(assScenario, "scenario.yaml")).toThrow(
      /no assSchema key.*ass try.*ass run|assSchema/s,
    );
  });

  test("an unknown assSchema names the supported version", () => {
    expect(() => parseDeclaration("assSchema: 2\nname: x\n", "x.yaml")).toThrow(
      /supports assSchema: 1/,
    );
  });

  test("verdict is impossible by construction (strict object)", () => {
    expect(() =>
      parseDeclaration(MINIMAL_YAML + "verdict:\n  probe: {}\n", "x.yaml"),
    ).toThrow(SimulatorLoadError);
  });

  test("invalid YAML is a load error naming the path", () => {
    expect(() => parseDeclaration(":\n  - {", "bad.yaml")).toThrow(
      /bad\.yaml: invalid YAML/,
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
});

// -- descriptor -------------------------------------------------------------

describe("held descriptor persistence", () => {
  const base: HeldDescriptor = {
    slug: "t-desc",
    mode: "up",
    assSchema: 1,
    scenarioPath: "/x/t.yaml",
    seed: 7,
    declarationDigest: "abc",
    heldAt: "2026-08-14T00:00:00.000Z",
    completedAt: null,
    ownsPlatform: false,
    teardown: [{ kind: "fake-account", username: "u" }],
  };

  test("write/read roundtrip, atomically (no tmp residue)", () => {
    const root = makeRoot();
    const file = writeHeldDescriptor(root, base);
    expect(readHeldDescriptor(root, "t-desc")).toEqual(base);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(readFileSync(file, "utf8")).toContain("\n  ");
  });

  test("absent reads as null; corrupt throws instead of reading absent", () => {
    const root = makeRoot();
    expect(readHeldDescriptor(root, "nope")).toBeNull();
    mkdirSync(path.dirname(heldFile(root, "bad")), { recursive: true });
    writeFileSync(heldFile(root, "bad"), "{ not json");
    expect(() => readHeldDescriptor(root, "bad")).toThrow(
      CorruptDescriptorError,
    );
    const listing = listHeldDescriptors(root);
    expect(listing.corrupt).toHaveLength(1);
    expect(listing.descriptors).toHaveLength(0);
  });
});

// -- lifecycle through the CLI ---------------------------------------------

describe("ass up", () => {
  test("row 1: fresh up boots the platform, holds it, ownsPlatform: true", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min", MINIMAL_YAML);
    const result = await cliSim(harness, ["up", "--file", "t-min.yaml"]);
    expect(result.code).toBe(0);
    expect(harness.driver.calls).toContain("up");
    expect(harness.driver.runDir).not.toBeNull();
    const descriptor = readHeldDescriptor(harness.root, "t-min");
    expect(descriptor?.ownsPlatform).toBe(true);
    expect(descriptor?.completedAt).not.toBeNull();
    expect(descriptor?.teardown).toEqual([
      { done: false, kind: "fake-account", username: "sim-user" },
    ]);
    expect(result.stdout).toContain("seed 42");
    expect(result.stdout).toContain("release with: ass down --file t-min.yaml");
  });

  test("row 2: reuses a running platform without rebooting", async () => {
    const harness = makeHarness();
    harness.driver.runDir = "/fake/run";
    writeScenario(harness.root, "t-min", MINIMAL_YAML);
    const result = await cliSim(harness, ["up", "--file", "t-min.yaml"]);
    expect(result.code).toBe(0);
    expect(harness.driver.calls).not.toContain("up");
    expect(harness.driver.calls).not.toContain("down");
    expect(readHeldDescriptor(harness.root, "t-min")?.ownsPlatform).toBe(false);
  });

  test("row 3: unchanged re-run is a cheap no-op", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min", MINIMAL_YAML);
    await cliSim(harness, ["up", "--file", "t-min.yaml"]);
    harness.applied = [];
    const rerun = await cliSim(harness, ["up", "--file", "t-min.yaml"]);
    expect(rerun.code).toBe(0);
    expect(rerun.stdout).toContain("already seeded: t-min (seed 42)");
    expect(harness.applied).toEqual([]);
    expect(readHeldDescriptor(harness.root, "t-min")?.teardown).toHaveLength(1);
  });

  test("row 4: scenario switch tears down previous data, keeps platform, transfers ownership", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min", MINIMAL_YAML);
    writeScenario(
      harness.root,
      "t-other",
      MINIMAL_YAML.replace("name: t-min", "name: t-other"),
    );
    await cliSim(harness, ["up", "--file", "t-min.yaml"]);
    const bootCalls = harness.driver.calls.filter((c) => c === "up").length;
    const result = await cliSim(harness, ["up", "--file", "t-other.yaml"]);
    expect(result.code).toBe(0);
    expect(harness.downed).toEqual(['fake-account:"sim-user"']);
    expect(harness.driver.calls.filter((c) => c === "up")).toHaveLength(
      bootCalls,
    );
    expect(harness.driver.calls).not.toContain("down");
    expect(readHeldDescriptor(harness.root, "t-min")).toBeNull();
    // The old up booted the stack; the platform outlives the swap, so the
    // new held state owns it.
    expect(readHeldDescriptor(harness.root, "t-other")?.ownsPlatform).toBe(
      true,
    );
    const listing = listHeldDescriptors(harness.root);
    expect(listing.descriptors.map((d) => d.slug)).toEqual(["t-other"]);
  });

  test("row 8: non-local target refuses before any write", async () => {
    const harness = makeHarness();
    harness.driver.env["WASMER_REGISTRY"] =
      "https://registry.wasmer.io/graphql";
    harness.driver.runDir = "/fake/run";
    writeScenario(harness.root, "t-min", MINIMAL_YAML);
    const result = await cliSim(harness, ["up", "--file", "t-min.yaml"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("WASMER_REGISTRY");
    expect(harness.applied).toEqual([]);
    expect(listHeldDescriptors(harness.root).descriptors).toHaveLength(0);
  });

  test("row 9: --plan prints the expansion with zero side effects", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min", MINIMAL_YAML);
    const result = await cliSim(harness, [
      "up",
      "--file",
      "t-min.yaml",
      "--plan",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("account: sim-user in sim-ns");
    expect(result.stdout).toContain("seed 42");
    expect(result.stdout).toContain("nothing was written");
    expect(harness.driver.calls).toEqual([]);
    expect(harness.applied).toEqual([]);
    expect(existsSync(path.join(harness.root, ".ass", "state"))).toBe(false);
  });

  test("seeder failure mid-up exits 4; descriptor covers what exists; down cleans", async () => {
    const harness = makeHarness();
    harness.failApply = "apps";
    writeScenario(
      harness.root,
      "t-apps",
      MINIMAL_YAML.replace("name: t-min", "name: t-apps") +
        "apps:\n  count: 2\n",
    );
    const result = await cliSim(harness, ["up", "--file", "t-apps.yaml"]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain(
      "recover with: ass down --file t-apps.yaml",
    );
    const descriptor = readHeldDescriptor(harness.root, "t-apps");
    expect(descriptor?.completedAt).toBeNull();
    // The first apps entry was emitted (and flushed) before the failure.
    expect(descriptor?.teardown.map((entry) => entry.kind)).toEqual([
      "fake-account",
      "fake-apps",
    ]);

    harness.failApply = undefined;
    const down = await cliSim(harness, ["down", "--file", "t-apps.yaml"]);
    expect(down.code).toBe(0);
    expect(readHeldDescriptor(harness.root, "t-apps")).toBeNull();
  });

  test("platform boot failure exits 4 with nothing held", async () => {
    const harness = makeHarness();
    harness.driver.failUp = true;
    writeScenario(harness.root, "t-min", MINIMAL_YAML);
    const result = await cliSim(harness, ["up", "--file", "t-min.yaml"]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("platform boot failed");
    expect(listHeldDescriptors(harness.root).descriptors).toHaveLength(0);
  });

  test("declaration errors exit 1: missing file, no assSchema, unknown version", async () => {
    const harness = makeHarness();
    const missing = await cliSim(harness, ["up", "--file", "nope.yaml"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("cannot read scenario file");

    writeScenario(harness.root, "ass-style", "meta:\n  id: X\n");
    const wrongFormat = await cliSim(harness, [
      "up",
      "--file",
      "ass-style.yaml",
    ]);
    expect(wrongFormat.code).toBe(1);
    expect(wrongFormat.stderr).toContain("no assSchema key");
    expect(wrongFormat.stderr).toContain("ass try");

    writeScenario(
      harness.root,
      "future",
      MINIMAL_YAML.replace("assSchema: 1", "assSchema: 2"),
    );
    const future = await cliSim(harness, ["up", "--file", "future.yaml"]);
    expect(future.code).toBe(1);
    expect(future.stderr).toContain("supports assSchema: 1");
  });

  test("a live concurrent up holds the lock and the second refuses", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min", MINIMAL_YAML);
    const lockDir = path.join(harness.root, ".ass", "state");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "up.lock"), String(process.pid));
    const result = await cliSim(harness, ["up", "--file", "t-min.yaml"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("another ass up is already running");

    // A dead holder is taken over instead of wedging the next run.
    writeFileSync(path.join(lockDir, "up.lock"), "999999999");
    const retry = await cliSim(harness, ["up", "--file", "t-min.yaml"]);
    expect(retry.code).toBe(0);
  });

  test("AC-6: descriptor never contains token or password material", async () => {
    const harness = makeHarness();
    writeScenario(
      harness.root,
      "t-full",
      MINIMAL_YAML.replace("name: t-min", "name: t-full") +
        "apps:\n  count: 2\n",
    );
    const result = await cliSim(harness, ["up", "--file", "t-full.yaml"]);
    expect(result.code).toBe(0);
    const raw = readFileSync(heldFile(harness.root, "t-full"), "utf8");
    expect(raw).not.toContain(SECRET_TOKEN);
    expect(raw).not.toContain(PG_PASSWORD);
  });
});

describe("ass down", () => {
  test("row 5: full down replays reverse order, releases descriptor and owned platform", async () => {
    const harness = makeHarness();
    writeScenario(
      harness.root,
      "t-full",
      MINIMAL_YAML.replace("name: t-min", "name: t-full") +
        "apps:\n  count: 2\n",
    );
    await cliSim(harness, ["up", "--file", "t-full.yaml"]);
    expect(harness.driver.runDir).not.toBeNull();

    const result = await cliSim(harness, ["down", "--file", "t-full.yaml"]);
    expect(result.code).toBe(0);
    // Reverse creation order: apps entries (last-in first), then account.
    expect(harness.downed).toEqual([
      'fake-apps:["a-2"]',
      'fake-apps:["a-1"]',
      'fake-account:"sim-user"',
    ]);
    expect(harness.driver.calls).toContain("down");
    expect(readHeldDescriptor(harness.root, "t-full")).toBeNull();
    expect(harness.driver.runDir).toBeNull();
  });

  test("does not release a platform it does not own", async () => {
    const harness = makeHarness();
    harness.driver.runDir = "/fake/run";
    writeScenario(harness.root, "t-min", MINIMAL_YAML);
    await cliSim(harness, ["up", "--file", "t-min.yaml"]);
    const result = await cliSim(harness, ["down", "t-min"]);
    expect(result.code).toBe(0);
    expect(harness.driver.calls).not.toContain("down");
    expect(harness.driver.runDir).toBe("/fake/run");
  });

  test("row 6: a failed entry keeps the descriptor; re-run resumes past done entries", async () => {
    const harness = makeHarness();
    writeScenario(
      harness.root,
      "t-full",
      MINIMAL_YAML.replace("name: t-min", "name: t-full") +
        "apps:\n  count: 2\n",
    );
    await cliSim(harness, ["up", "--file", "t-full.yaml"]);

    harness.failDownKind = "fake-account";
    const first = await cliSim(harness, ["down", "t-full"]);
    expect(first.code).toBe(4);
    expect(first.stderr).toContain("re-run `ass down` to resume");
    const kept = readHeldDescriptor(harness.root, "t-full");
    expect(kept).not.toBeNull();
    expect(
      kept?.teardown.filter((entry) => entry.done === true).map((e) => e.kind),
    ).toEqual(["fake-apps", "fake-apps"]);
    // Platform must not be torn down under a partial data teardown.
    expect(harness.driver.runDir).not.toBeNull();

    harness.failDownKind = undefined;
    harness.downed = [];
    const second = await cliSim(harness, ["down", "t-full"]);
    expect(second.code).toBe(0);
    expect(harness.downed).toEqual(['fake-account:"sim-user"']);
    expect(readHeldDescriptor(harness.root, "t-full")).toBeNull();
  });

  test("row 7: platform gone ⇒ fast release without touching datastores", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min", MINIMAL_YAML);
    await cliSim(harness, ["up", "--file", "t-min.yaml"]);
    // Platform dies externally (compose down; volumes gone), symlink stays.
    harness.driver.backendDead = true;
    harness.downed = [];
    const result = await cliSim(harness, ["down", "t-min"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("platform is not serving");
    expect(harness.downed).toEqual([]);
    expect(readHeldDescriptor(harness.root, "t-min")).toBeNull();
  });

  test("D-J: edited file warns and proceeds from the descriptor", async () => {
    const harness = makeHarness();
    const file = writeScenario(harness.root, "t-min", MINIMAL_YAML);
    await cliSim(harness, ["up", "--file", "t-min.yaml"]);
    writeFileSync(file, MINIMAL_YAML + "description: edited\n");
    const result = await cliSim(harness, ["down", "--file", "t-min.yaml"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("has changed since");
    expect(readHeldDescriptor(harness.root, "t-min")).toBeNull();
  });

  test("nothing held is a successful no-op (idempotent outer boundary)", async () => {
    const harness = makeHarness();
    const named = await cliSim(harness, ["down", "ghost"]);
    expect(named.code).toBe(0);
    expect(named.stdout).toContain("already released");
    const bare = await cliSim(harness, ["down"]);
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain("nothing is held");
  });

  test("corrupt descriptor is reported, never treated as absent", async () => {
    const harness = makeHarness();
    mkdirSync(path.dirname(heldFile(harness.root, "bad")), { recursive: true });
    writeFileSync(heldFile(harness.root, "bad"), "{ nope");
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

    writeScenario(harness.root, "t-min", MINIMAL_YAML);
    await cliSim(harness, ["up", "--file", "t-min.yaml"]);
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
      entries: { "fake-account": { done: 0, total: 1 } },
      doneEntries: 0,
      totalEntries: 1,
    });
    expect(typeof parsed.held[0].ageSeconds).toBe("number");
  });

  test("human output covers held state and platform liveness", async () => {
    const harness = makeHarness();
    writeScenario(harness.root, "t-min", MINIMAL_YAML);
    await cliSim(harness, ["up", "--file", "t-min.yaml"]);
    const result = await cliSim(harness, ["status"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("held: t-min (seed 42");
    expect(result.stdout).toContain("fake-account 0/1");
    expect(result.stdout).toContain("platform: serving");
  });

  test("existing verbs are untouched by the new commands (help still routes)", async () => {
    const harness = makeHarness();
    const result = await cliSim(harness, ["list"]);
    expect(result.code).toBe(0);
  });
});
