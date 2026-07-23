// State-manager tests (Phase 2): source grammar, the local-platform driver's
// backed-up file mutations against a real temp filesystem, and resolveLocal's
// lifecycle — setup-failed classification, cleanup on success and failure,
// and cleanup errors surfacing without masking the original failure.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAppSource, SourceParseError } from "../../ass/fixtures/sources";
import {
  DriverError,
  LocalPlatformDriver,
  parseGeneratedEnvFile,
  type ExecFn,
} from "../../ass/fixtures/localPlatform";
import { resolveLocal, SetupFailedError } from "../../ass/fixtures/local";
import { parseScenario, type Scenario } from "../../ass/scenario/schema";
import { makeFakeHarness } from "./helpers";

const tmpRoots: string[] = [];
afterAll(() => {
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRepoDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ass-driver-"));
  tmpRoots.push(dir);
  return dir;
}

describe("app source grammar", () => {
  test.each([
    [
      "template:next-react-server-components",
      { kind: "template", slug: "next-react-server-components" },
    ],
    ["fixture:php/app", { kind: "fixture", path: "php/app" }],
    // A non-wasmer namespace: bare "wasmer/<x>" strings are discovered by
    // local-platform/scripts/seed-packages.mjs and would be mirrored at boot.
    ["package:acme/probe-pkg", { kind: "package", ref: "acme/probe-pkg" }],
    ["package:./probe", { kind: "package", ref: "./probe" }],
    [
      "backup:ass-store://wp-cust-123@v2",
      { kind: "backup", ref: "ass-store://wp-cust-123@v2" },
    ],
  ])("%s parses", (source, expected) => {
    expect(parseAppSource("victim", source)).toEqual(expected);
  });

  test.each([
    ["carrier-pigeon:x", /unknown source kind "carrier-pigeon"/],
    ["template:", /no value after the kind prefix/],
    ["no-colon", /no value after the kind prefix/],
    ["fixture:/etc/passwd", /inside the scenario directory/],
    ["fixture:../outside", /inside the scenario directory/],
  ])("%s is rejected", (source, expected) => {
    expect(() => parseAppSource("victim", source)).toThrow(SourceParseError);
    expect(() => parseAppSource("victim", source)).toThrow(expected);
  });
});

describe("local-platform driver file mutations", () => {
  const COMPOSE =
    "services:\n  backend:\n    image: b\n  edge:\n    image: e\n";

  function makeDriver(repoDir: string): LocalPlatformDriver {
    writeFileSync(
      path.join(repoDir, "docker-compose.local-platform.yaml"),
      COMPOSE,
    );
    return new LocalPlatformDriver(repoDir, { io: { info: () => {} } });
  }

  test("pins append to an existing local.env and restore byte-for-byte", () => {
    const repoDir = makeRepoDir();
    const driver = makeDriver(repoDir);
    const localEnv = path.join(repoDir, "local.env");
    const original =
      "export BACKEND_VERSION=resolve_dev\nexport VERBOSE=true\n";
    writeFileSync(localEnv, original);

    driver.applyPins({ EDGE_VERSION: "github-release:wasmerio/edge:v1:edge" });
    const mutated = readFileSync(localEnv, "utf8");
    // Appended: sequential-source semantics mean the pin wins over the
    // original BACKEND_VERSION line while VERBOSE survives.
    expect(mutated.startsWith(original)).toBe(true);
    expect(mutated).toContain(
      "export EDGE_VERSION='github-release:wasmerio/edge:v1:edge'",
    );
    expect(existsSync(`${localEnv}.ass-bak`)).toBe(true);

    expect(driver.restoreFiles()).toEqual([]);
    expect(readFileSync(localEnv, "utf8")).toBe(original);
    expect(existsSync(`${localEnv}.ass-bak`)).toBe(false);
  });

  test("pins on a missing local.env create it and remove it on restore", () => {
    const repoDir = makeRepoDir();
    const driver = makeDriver(repoDir);
    const localEnv = path.join(repoDir, "local.env");

    driver.applyPins({ BACKEND_VERSION: "x" });
    expect(existsSync(localEnv)).toBe(true);
    expect(driver.restoreFiles()).toEqual([]);
    expect(existsSync(localEnv)).toBe(false);
  });

  test("a stale backup from a crashed run refuses to be clobbered", () => {
    const repoDir = makeRepoDir();
    const driver = makeDriver(repoDir);
    writeFileSync(path.join(repoDir, "local.env.ass-bak"), "old backup");
    expect(() => driver.applyPins({ EDGE_VERSION: "x" })).toThrow(
      /stale backup .* did not restore/,
    );
  });

  test("cpus cap inserts under the service and restores", () => {
    const repoDir = makeRepoDir();
    const driver = makeDriver(repoDir);
    const compose = path.join(repoDir, "docker-compose.local-platform.yaml");

    driver.applyCpus("edge", 1);
    expect(readFileSync(compose, "utf8")).toContain("  edge:\n    cpus: 1\n");
    expect(driver.restoreFiles()).toEqual([]);
    expect(readFileSync(compose, "utf8")).toBe(COMPOSE);
  });

  test("cpus cap on an unknown service is a loud error", () => {
    const repoDir = makeRepoDir();
    const driver = makeDriver(repoDir);
    expect(() => driver.applyCpus("garnish", 1)).toThrow(
      /no service "garnish"/,
    );
  });

  test("container-owned cache entries fall back to the docker wipe", () => {
    // Root-owned cache entries (rootful Docker) make plain rm hit EACCES;
    // simulate with a read-only cache dir whose entries cannot be unlinked.
    const repoDir = makeRepoDir();
    const cacheDir = path.join(repoDir, ".local-platform", "cache", "edge");
    const target = path.join(cacheDir, "compiler_cache");
    mkdirSync(path.join(target, "entry"), { recursive: true });
    chmodSync(target, 0o555);
    const wiped: string[] = [];
    const driver = new LocalPlatformDriver(repoDir, {
      io: { info: () => {} },
      dockerWipe: (dir) => {
        wiped.push(dir);
        chmodSync(dir, 0o755);
        rmSync(path.join(dir, "entry"), { recursive: true, force: true });
      },
    });
    driver.wipeCaches("edge", ["compiler_cache"]);
    expect(wiped).toEqual([target]);
    expect(existsSync(target)).toBe(false);
  });

  test("cache wipes remove named dirs and reject traversal", () => {
    const repoDir = makeRepoDir();
    const driver = makeDriver(repoDir);
    const cacheDir = path.join(repoDir, ".local-platform", "cache", "edge");
    mkdirSync(path.join(cacheDir, "compiler_cache"), { recursive: true });
    mkdirSync(path.join(cacheDir, "webc_cache"), { recursive: true });

    driver.wipeCaches("edge", ["compiler_cache"]);
    expect(existsSync(path.join(cacheDir, "compiler_cache"))).toBe(false);
    expect(existsSync(path.join(cacheDir, "webc_cache"))).toBe(true);

    expect(() => driver.wipeCaches("edge", ["../../../etc"])).toThrow(
      DriverError,
    );
    expect(() => driver.wipeCaches("edge", [".."])).toThrow(DriverError);
  });

  test("up spawns the local-platform CLI and maps nonzero exits to errors", async () => {
    const repoDir = makeRepoDir();
    const seen: Array<{
      argv: string[];
      autoDown: string | undefined;
      ensureCompiled: string | undefined;
    }> = [];
    let code = 0;
    const exec: ExecFn = async (argv, opts) => {
      seen.push({
        argv,
        autoDown: opts.env["LOCAL_PLATFORM_AUTO_DOWN"],
        ensureCompiled: opts.env["LOCAL_PLATFORM_ENSURE_COMPILED"],
      });
      return code;
    };
    const driver = new LocalPlatformDriver(repoDir, {
      exec,
      io: { info: () => {} },
    });

    await driver.up({ LOCAL_PLATFORM_ENSURE_COMPILED: "0" });
    expect(seen[0].argv.slice(0, 2)).toEqual([
      "python3",
      path.join(repoDir, "local-platform", "cli.py"),
    ]);
    expect(seen[0].argv[2]).toBe("up");
    expect(seen[0].autoDown).toBe("0");
    expect(seen[0].ensureCompiled).toBe("0");

    code = 3;
    await expect(driver.up()).rejects.toThrow(/up failed with status 3/);
  });

  test("parseGeneratedEnvFile reads shlex-quoted export lines", () => {
    const parsed = parseGeneratedEnvFile(
      [
        "export PLAIN=simple",
        "export QUOTED='http://localhost:19080/graphql'",
        "export ESCAPED='it'\\''s fine'",
        'export DOUBLE="quoted"',
        "# comment",
        "not an export",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      PLAIN: "simple",
      QUOTED: "http://localhost:19080/graphql",
      ESCAPED: "it's fine",
      DOUBLE: "quoted",
    });
  });
});

describe("resolveLocal lifecycle", () => {
  const SCENARIO_YAML: Scenario = parseScenario(
    {
      meta: { id: "WAX-600", title: "t", lifecycle: { state: "open" } },
      fixtures: {
        components: { edge: "github-release:wasmerio/edge:v1:edge" },
        perturbations: {
          edge: { cpus: 1, wipe_caches: ["compiler_cache"] },
        },
      },
      load: { executor: "jest", jest: { spec: "tests/x.test.ts" } },
      verdict: {
        reproduced_when: {
          any: [{ log_matches: { stream: "edge", pattern: "panic" } }],
        },
        baseline: { waived: "platform bug" },
      },
    },
    "persisted",
  );

  test("setup precedes state; cleanup tears down and restores", async () => {
    const harness = makeFakeHarness();
    const state = await resolveLocal(
      SCENARIO_YAML,
      "/scenario",
      {
        components: { edge: "github-release:wasmerio/edge:v1:edge" },
        perturbations: { edge: { cpus: 1, wipe_caches: ["compiler_cache"] } },
        executor: "jest",
      },
      { driver: harness.deps.driver, io: { info: () => {} } },
    );

    expect(harness.calls).toEqual([
      "pins:EDGE_VERSION=github-release:wasmerio/edge:v1:edge",
      "cpus:edge=1",
      "wipe:edge:compiler_cache",
      "up",
    ]);
    // Precompiling into a declared-wiped compiler cache is contradictory:
    // the boot must skip it.
    expect(harness.upEnv).toEqual({ LOCAL_PLATFORM_ENSURE_COMPILED: "0" });
    expect(state.env).toBe("local");
    expect(state.components).toEqual({
      edge: "github-release:wasmerio/edge:v2026-08-05_1_419b336_dev1:edge",
    });
    // Same value here, but they answer different questions: `components` is
    // the version, `pins` is a selector promotion can write back.
    expect(state.pins).toEqual({
      edge: "github-release:wasmerio/edge:v2026-08-05_1_419b336_dev1:edge",
    });
    expect(state.execEnv["WASMER_REGISTRY"]).toBeDefined();
    expect(existsSync(state.artifactsDir)).toBe(true);
    expect(state.composeLogPath).toContain("compose.follow.log");

    expect(await state.cleanup()).toEqual([]);
    expect(harness.calls.slice(4)).toEqual(["down", "restore"]);
  });

  test("a package component resolves for the executor without booting a stack", async () => {
    const harness = makeFakeHarness();
    const state = await resolveLocal(
      // No apps, no platform components, no perturbations: a raw-wasmer run
      // asks nothing of Edge or the backend, so it must not pay for a boot.
      {
        ...SCENARIO_YAML,
        fixtures: {},
        verdict: { probe: { channels: [{ type: "log", stream: "stderr" }] } },
      },
      "/scenario",
      {
        components: {
          python: "registry:python/python@=3.13.5",
          local: "path:./build",
        },
        perturbations: {},
        executor: "raw-wasmer",
      },
      { driver: harness.deps.driver, io: { info: () => {} } },
    );
    expect(harness.calls).toEqual([]);
    // `registry:`/`@=` is ASS's pinning grammar, not the wasmer CLI's.
    expect(state.variables["component.python"]).toBe("python/python@3.13.5");
    expect(state.variables["component.local"]).toBe("/scenario/build");
    // Package components pin to themselves: nothing else resolved them.
    expect(state.pins["python"]).toBe("registry:python/python@=3.13.5");
    expect(state.composeLogPath).toBeNull();
    expect(await state.cleanup()).toEqual([]);
  });

  test("a failed boot cleans partial state and reports setup-failed", async () => {
    const harness = makeFakeHarness({ failUp: "resolver exploded" });
    const attempt = resolveLocal(
      SCENARIO_YAML,
      "/scenario",
      {
        components: { edge: "github-release:wasmerio/edge:v1:edge" },
        perturbations: {},
        executor: "jest",
      },
      { driver: harness.deps.driver, io: { info: () => {} } },
    );
    await expect(attempt).rejects.toThrow(SetupFailedError);
    // The failure identifies the components and cleanup ran (down+restore).
    expect(harness.calls).toEqual([
      "pins:EDGE_VERSION=github-release:wasmerio/edge:v1:edge",
      "up",
      "down",
      "restore",
    ]);
  });

  test("cleanup errors surface without masking the original failure", async () => {
    const harness = makeFakeHarness({
      failUp: "resolver exploded",
      restoreErrors: ["could not restore local.env: EACCES"],
    });
    try {
      await resolveLocal(
        SCENARIO_YAML,
        "/scenario",
        {
          components: { edge: "github-release:wasmerio/edge:v1:edge" },
          perturbations: {},
          executor: "jest",
        },
        { driver: harness.deps.driver, io: { info: () => {} } },
      );
      throw new Error("expected SetupFailedError");
    } catch (err) {
      expect(err).toBeInstanceOf(SetupFailedError);
      const setupError = err as SetupFailedError;
      expect(setupError.message).toContain("resolver exploded");
      expect(setupError.cleanupErrors).toEqual([
        "could not restore local.env: EACCES",
      ]);
    }
  });

  test("a failing app deployment is a setup failure and cleans up", async () => {
    const scenario = parseScenario(
      {
        meta: { id: "X", title: "t", lifecycle: { state: "open" } },
        fixtures: {
          apps: { victim: { source: "template:worker" } },
        },
        load: { executor: "jest", jest: { spec: "tests/x.test.ts" } },
        verdict: {
          reproduced_when: {
            any: [{ output_matches: { pattern: "boom" } }],
          },
          baseline: { waived: "n/a" },
        },
      },
      "persisted",
    );
    const harness = makeFakeHarness();
    const attempt = resolveLocal(
      scenario,
      "/scenario",
      { components: {}, perturbations: {}, executor: "jest" },
      {
        driver: harness.deps.driver,
        io: { info: () => {} },
        deployApp: async () => {
          throw new Error("deploy exploded");
        },
      },
    );
    await expect(attempt).rejects.toThrow(/deploy exploded/);
    expect(harness.calls).toEqual(["up", "down", "restore"]);
  });

  test("cleanup removes deployed app temp dirs (R3-04)", async () => {
    const scenario = parseScenario(
      {
        meta: { id: "X", title: "t", lifecycle: { state: "open" } },
        fixtures: {
          apps: { victim: { source: "template:worker" } },
        },
        load: { executor: "jest", jest: { spec: "tests/x.test.ts" } },
        verdict: {
          reproduced_when: { any: [{ output_matches: { pattern: "x" } }] },
          baseline: { waived: "n/a" },
        },
      },
      "persisted",
    );
    const harness = makeFakeHarness();
    const appDir = mkdtempSync(path.join(tmpdir(), "ass-app-"));
    writeFileSync(path.join(appDir, "app.yaml"), "kind: wasmer.io/App.v0\n");
    const state = await resolveLocal(
      scenario,
      "/scenario",
      { components: {}, perturbations: {}, executor: "jest" },
      {
        driver: harness.deps.driver,
        io: { info: () => {} },
        deployApp: async () => ({
          url: "https://victim.localhost",
          appId: "app-victim",
          dir: appDir,
        }),
      },
    );
    expect(state.variables["victim.path"]).toBe(appDir);
    expect(await state.cleanup()).toEqual([]);
    expect(existsSync(appDir)).toBe(false);
  });

  test("config.max_instances is verified against the generated edge config", async () => {
    const scenario = parseScenario(
      {
        meta: { id: "X", title: "t", lifecycle: { state: "open" } },
        fixtures: {
          apps: {
            victim: { source: "template:worker", config: { max_instances: 1 } },
          },
        },
        load: { executor: "jest", jest: { spec: "tests/x.test.ts" } },
        verdict: {
          reproduced_when: { any: [{ output_matches: { pattern: "x" } }] },
          baseline: { waived: "n/a" },
        },
      },
      "persisted",
    );

    // Honored: the fake writes the single-instance guarantee on up().
    const good = makeFakeHarness();
    const state = await resolveLocal(
      scenario,
      "/scenario",
      { components: {}, perturbations: {}, executor: "jest" },
      {
        driver: good.deps.driver,
        deployApp: good.deps.deployApp,
        io: { info: () => {} },
      },
    );
    expect(state.variables["victim.url"]).toBe("https://victim.localhost");
    // No compiler_cache wipe declared: precompilation stays on.
    expect(good.upEnv).toEqual({});
    await state.cleanup();

    // Drifted config: loud setup failure, never a silent degrade (D13).
    const bad = makeFakeHarness();
    const driver = bad.deps.driver!;
    const originalUp = driver.up.bind(driver);
    driver.up = async () => {
      await originalUp();
      writeFileSync(driver.edgePlatformConfigPath(), "socket: {}\n");
    };
    await expect(
      resolveLocal(
        scenario,
        "/scenario",
        { components: {}, perturbations: {}, executor: "jest" },
        { driver, deployApp: bad.deps.deployApp, io: { info: () => {} } },
      ),
    ).rejects.toThrow(/cannot honor config.max_instances/);
  });
});
