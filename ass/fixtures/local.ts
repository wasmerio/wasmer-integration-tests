// Local fixture lifecycle (QA-635, Phase 2): resolve component selectors to
// local-platform pins, apply local-only perturbations, boot the disposable
// stack, deploy declared app fixtures, and hand back a typed ResolvedState
// whose cleanup handle restores every mutated file and process. Fixture
// failures end as SetupFailedError — reported distinctly, after partial
// state is cleaned (integration-contract row "fixture failure").

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { ResolvedState } from "../executors/contract";
import type { Scenario } from "../scenario/schema";
import { parseAppSource, SourceParseError, type AppSource } from "./sources";
import { classifyLogStream, collectPredicates } from "../engine/capabilities";
import {
  LocalPlatformDriver,
  type DriverIo,
  type PlatformDriver,
} from "./localPlatform";

/** Component name -> the env var the local platform resolves it through.
 * These are the *platform* components: pinning one means booting a stack. */
const LOCAL_COMPONENT_ENV_VARS: Record<string, string> = {
  edge: "EDGE_VERSION",
  backend: "BACKEND_VERSION",
};

/** Everything else is a *package* component (D8): a package under test that
 * an executor consumes directly — `python/python@3.13.5` handed to
 * `wasmer run`, or a local build via `path:`. It pins and overrides through
 * the same D12 surface, it just never reaches docker compose.
 *
 * The selector is translated to what a tool actually accepts: `registry:` and
 * the exact-version `@=` spelling are ASS's pinning grammar, not the wasmer
 * CLI's. */
export function packageComponentValue(
  selector: string,
  scenarioDir: string,
): string {
  if (selector.startsWith("path:")) {
    const target = selector.slice("path:".length);
    return path.isAbsolute(target) ? target : path.resolve(scenarioDir, target);
  }
  if (selector.startsWith("registry:")) {
    return selector.slice("registry:".length).replace("@=", "@");
  }
  return selector;
}

export class SetupFailedError extends Error {
  readonly cleanupErrors: string[];

  constructor(message: string, cleanupErrors: string[] = []) {
    super(message);
    this.name = "SetupFailedError";
    this.cleanupErrors = cleanupErrors;
  }
}

export interface Perturbation {
  cpus?: number;
  wipe_caches?: string[];
}

/** Declared fixtures merged with CLI overrides (D12); computed by the
 * runner so override-validation errors stay usage errors, not setup
 * failures. */
export interface EffectiveFixtures {
  components: Record<string, string>;
  perturbations: Record<string, Perturbation>;
  /** The one active load profile (D8); decides which fixtures are needed. */
  executor: string;
}

export interface DeployedApp {
  url: string;
  appId: string;
  dir: string;
}

export type AppDeployer = (
  fixtureName: string,
  source: AppSource,
  ctx: { scenarioDir: string; testEnv: Record<string, string> },
) => Promise<DeployedApp>;

export interface LocalResolveDeps {
  driver?: PlatformDriver;
  deployApp?: AppDeployer;
  io?: DriverIo;
}

function defaultDeployer(): AppDeployer {
  return async (fixtureName, source, ctx) => {
    const { deployAppFixture } = await import("./deploy");
    return deployAppFixture(fixtureName, source, ctx);
  };
}

/** D13 on local: the disposable stack is a single Edge node whose generated
 * platform config caps instances at one per node, so `max_instances: 1` (and
 * any larger bound) holds by construction. Verify the guarantee instead of
 * assuming it, and fail setup loudly if the config drifts. */
function verifyMaxInstancesHonored(
  scenario: Scenario,
  platformConfigPath: string,
): void {
  const declaring = [
    ...Object.entries(scenario.fixtures.apps ?? {}),
    ...Object.entries(scenario.fixtures.probes ?? {}),
  ].filter(([, fixture]) => fixture.config?.max_instances !== undefined);
  if (declaring.length === 0) {
    return;
  }
  let config = "";
  try {
    config = readFileSync(platformConfigPath, "utf8");
  } catch {
    throw new SetupFailedError(
      "cannot verify config.max_instances (declared by " +
        `${declaring.map(([name]) => name).join(", ")}): missing generated ` +
        `edge config ${platformConfigPath}`,
    );
  }
  if (!/reuse_instance_max_instances_per_node:\s*1\b/.test(config)) {
    throw new SetupFailedError(
      "cannot honor config.max_instances on local: the generated edge " +
        `config ${platformConfigPath} no longer caps instances at one per ` +
        "node (reuse_instance_max_instances_per_node: 1); refusing to run " +
        "a structurally false-negative reproduction (D13)",
    );
  }
}

/** Does this run need the disposable stack at all? A `raw-wasmer` probe with
 * no platform components asks nothing of Edge or the backend, and booting six
 * minutes of containers to run `wasmer run` would make the fast investigation
 * path the slow one. */
export function requiresPlatform(
  scenario: Scenario,
  effective: EffectiveFixtures,
): boolean {
  if (
    Object.keys(effective.components).some(
      (name) => name in LOCAL_COMPONENT_ENV_VARS,
    )
  ) {
    return true;
  }
  if (Object.keys(scenario.fixtures.apps ?? {}).length > 0) {
    return true;
  }
  if (Object.keys(effective.perturbations).length > 0) {
    return true;
  }
  // A verdict that reads Edge's or the backend's own logs needs them running.
  const streams: string[] = [];
  for (const predicate of collectPredicates(scenario.verdict ?? {})) {
    if (predicate.stream !== undefined) {
      streams.push(predicate.stream);
    }
  }
  for (const entry of scenario.verdict?.collect ?? []) {
    for (const spec of Object.values(entry)) {
      streams.push(spec.stream);
    }
  }
  return streams.some(
    (stream) => classifyLogStream(stream) === "platform-process",
  );
}

/** Probe affordances. Harness-owned probe *deployment* lands in Phase 5 (D9);
 * until then a probe resolves to the path or package a process executor can
 * run it from. */
function resolveProbeVariables(
  scenario: Scenario,
  scenarioDir: string,
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [name, fixture] of Object.entries(scenario.fixtures.probes ?? {})) {
    const source = parseAppSource(name, fixture.source);
    if (source.kind === "fixture") {
      const dir = path.join(scenarioDir, source.path);
      if (!existsSync(dir)) {
        throw new SetupFailedError(
          `probe fixture "${name}": ${dir} does not exist`,
        );
      }
      variables[`${name}.path`] = dir;
    } else if (source.kind === "package" && source.ref.startsWith("./")) {
      const dir = path.join(scenarioDir, source.ref);
      if (!existsSync(dir)) {
        throw new SetupFailedError(
          `probe fixture "${name}": ${dir} does not exist`,
        );
      }
      variables[`${name}.path`] = dir;
    } else if (source.kind === "package") {
      variables[`${name}.package`] = source.ref;
    } else {
      throw new SetupFailedError(
        `probe fixture "${name}": source kind "${source.kind}" is not ` +
          "resolvable locally",
      );
    }
  }
  return variables;
}

/** Component pins + parsed sources, computed before anything is mutated so a
 * bad declaration fails fast (still as a setup failure). */
function planResolution(
  scenario: Scenario,
  scenarioDir: string,
  effective: EffectiveFixtures,
): {
  pins: Record<string, string>;
  packages: Record<string, string>;
  appSources: Array<[string, AppSource]>;
} {
  const pins: Record<string, string> = {};
  const packages: Record<string, string> = {};
  for (const [name, selector] of Object.entries(effective.components)) {
    const envVar = LOCAL_COMPONENT_ENV_VARS[name];
    if (envVar === undefined) {
      packages[name] = packageComponentValue(selector, scenarioDir);
      continue;
    }
    pins[envVar] = selector;
  }

  const appSources: Array<[string, AppSource]> = [];
  try {
    for (const [name, fixture] of Object.entries(
      scenario.fixtures.apps ?? {},
    )) {
      appSources.push([name, parseAppSource(name, fixture.source)]);
    }
  } catch (err) {
    if (err instanceof SourceParseError) {
      throw new SetupFailedError(err.message);
    }
    throw err;
  }
  for (const [name, source] of appSources) {
    if (source.kind === "backup") {
      throw new SetupFailedError(
        `app fixture "${name}": backup: sources require BE-666 and land in ` +
          "Phase 5",
      );
    }
  }
  return { pins, packages, appSources };
}

export async function resolveLocal(
  scenario: Scenario,
  scenarioDir: string,
  effective: EffectiveFixtures,
  deps: LocalResolveDeps = {},
): Promise<ResolvedState> {
  const io = deps.io ?? {
    info: (line: string) => process.stderr.write(`${line}\n`),
  };
  const driver = deps.driver ?? new LocalPlatformDriver(process.cwd(), { io });

  const { pins, packages, appSources } = planResolution(
    scenario,
    scenarioDir,
    effective,
  );
  const needsPlatform = requiresPlatform(scenario, effective);

  // Deploys create temp dirs on the host (the platform-side apps die with
  // `down`); the cleanup handle owns their removal because `<name>.path`
  // variables point into them for the workload's duration.
  const deployedDirs: string[] = [];
  const cleanup = async (): Promise<string[]> => {
    const errors: string[] = [];
    const downError = await driver.down();
    if (downError !== null) {
      errors.push(downError);
    }
    errors.push(...driver.restoreFiles());
    for (const dir of deployedDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        errors.push(`could not remove deployed app dir ${dir}: ${String(err)}`);
      }
    }
    return errors;
  };

  // A workload that asks nothing of Edge or the backend does not get a
  // six-minute boot: `wasmer run` against a package component is the fast end
  // of the investigation path, and making it slow would push people back to
  // hand-written scripts. Nothing is mutated on this path, so cleanup is a
  // no-op and an interrupt has nothing to restore.
  if (!needsPlatform) {
    io.info(
      "no platform components, apps or perturbations declared — running " +
        "without the local stack",
    );
    const variables = resolveProbeVariables(scenario, scenarioDir);
    for (const [name, selector] of Object.entries(effective.components)) {
      variables[`component.${name}`] = packages[name] ?? selector;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const artifactsDir = path.join(
      driver.repoDir,
      ".local-platform",
      "ass",
      "runs",
      stamp,
    );
    mkdirSync(artifactsDir, { recursive: true });
    return {
      env: "local",
      variables,
      components: { ...effective.components },
      pins: { ...effective.components },
      execEnv: {},
      artifactsDir,
      composeLogPath: null,
      cleanup: async () => [],
    };
  }

  // Perturbations only take effect on a fresh boot: a reused stack was built
  // from the unperturbed compose file and warm caches. Local is disposable,
  // so tear down any current run first (before any file is mutated).
  if (driver.currentRunDir() !== null) {
    io.info(
      "existing local platform run found; tearing it down for a fresh, pinned boot",
    );
    const downError = await driver.down();
    if (downError !== null) {
      io.info(
        `warning: ${downError} (continuing; port checks will catch leftovers)`,
      );
    }
  }

  try {
    if (Object.keys(pins).length > 0) {
      driver.applyPins(pins);
    }
    for (const [service, perturbation] of Object.entries(
      effective.perturbations,
    )) {
      if (perturbation.cpus !== undefined) {
        driver.applyCpus(service, perturbation.cpus);
        io.info(`perturbation: capped ${service} at cpus=${perturbation.cpus}`);
      }
      if (perturbation.wipe_caches !== undefined) {
        driver.wipeCaches(service, perturbation.wipe_caches);
      }
    }

    // Precompiling the seeded package set into a compiler cache the scenario
    // declared wiped is contradictory: it burns ~10 minutes (worse under a
    // cpus cap) and partially undoes the declared cold-cache perturbation.
    // Anything the workload needs cold-compiles at first request — which is
    // exactly what the wipe asks for.
    const wipesCompilerCache = Object.values(effective.perturbations).some(
      (perturbation) => perturbation.wipe_caches?.includes("compiler_cache"),
    );
    if (wipesCompilerCache) {
      io.info(
        "compiler_cache is declared wiped — skipping boot-time package " +
          "precompilation (LOCAL_PLATFORM_ENSURE_COMPILED=0)",
      );
    }
    await driver.up(
      wipesCompilerCache ? { LOCAL_PLATFORM_ENSURE_COMPILED: "0" } : {},
    );

    const testEnv = driver.readTestEnv();
    const resolvedEnv = driver.readResolvedEnv();
    verifyMaxInstancesHonored(scenario, driver.edgePlatformConfigPath());

    const components: Record<string, string> = {};
    // What the platform recorded as the selector it actually consumed —
    // `EDGE_RESOLVED` and `BACKEND_IMAGE_SOURCE` are themselves selectors, so
    // a floating declaration can be pinned from them (`ass promote`). The
    // backend falls back to its image ref, which promote classifies (a
    // mutable docker tag is not a pin) rather than trusting blindly.
    const resolvedPins: Record<string, string> = {};
    for (const name of Object.keys(effective.components)) {
      const resolved =
        name === "edge"
          ? resolvedEnv["EDGE_RESOLVED"]
          : name === "backend"
            ? resolvedEnv["BACKEND_IMAGE_REF"]
            : undefined;
      components[name] = resolved || effective.components[name];
      const pin =
        name === "edge"
          ? resolvedEnv["EDGE_RESOLVED"]
          : name === "backend"
            ? resolvedEnv["BACKEND_IMAGE_SOURCE"] ||
              resolvedEnv["BACKEND_IMAGE_REF"]
            : undefined;
      resolvedPins[name] = pin || effective.components[name];
    }

    const variables: Record<string, string> = {};
    for (const [name, source] of appSources) {
      const deploy = deps.deployApp ?? defaultDeployer();
      io.info(`deploying app fixture "${name}" (${source.kind})`);
      const app = await deploy(name, source, { scenarioDir, testEnv });
      deployedDirs.push(app.dir);
      variables[`${name}.url`] = app.url;
      variables[`${name}.app_id`] = app.appId;
      variables[`${name}.path`] = app.dir;
    }
    Object.assign(variables, resolveProbeVariables(scenario, scenarioDir));
    for (const [name, selector] of Object.entries(effective.components)) {
      variables[`component.${name}`] =
        packages[name] ?? components[name] ?? selector;
    }

    const runDir = driver.currentRunDir();
    if (runDir === null) {
      throw new SetupFailedError(
        "local platform reported success but has no run dir",
      );
    }
    const artifactsDir = path.join(runDir, "ass");
    mkdirSync(artifactsDir, { recursive: true });

    return {
      env: "local",
      variables,
      components,
      pins: resolvedPins,
      execEnv: testEnv,
      artifactsDir,
      composeLogPath: driver.composeFollowLogPath(),
      cleanup,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const pinSummary = Object.entries(effective.components)
      .map(([name, selector]) => `${name}=${selector}`)
      .join(", ");
    const cleanupErrors = await cleanup();
    throw new SetupFailedError(
      err instanceof SetupFailedError
        ? detail
        : `${detail}${pinSummary ? ` (components: ${pinSummary})` : ""}`,
      cleanupErrors,
    );
  }
}
