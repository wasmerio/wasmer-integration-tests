// Remote fixture lifecycle (QA-640, Phase 5): resolve a scenario against dev,
// Bugtopia or production through the existing TestEnv identity flow. The
// target environment stays a CLI input (never scenario data); platform
// components cannot be pinned remotely — the target runs whatever it runs, so
// a declaration that pins `edge`/`backend` derives a floating-mode run with a
// loud warning instead of a silent false pin. Probe fixtures gain their `url`
// affordance here: a `package:` probe deploys on demand through TestEnv, and
// the cleanup handle tears it down, naming anything it leaks (D9).
//
// Scenarios contain no secrets: identity comes from WASMER_TOKEN or the
// per-registry token in ~/.wasmer/wasmer.toml, and is never written to state,
// reports or provenance.

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { PreflightError } from "../errors";
import type { ResolvedState, TargetEnv } from "../executors/contract";
import type { Scenario } from "../scenario/schema";
import { checkReference, templateReferences } from "../executors/template";
import {
  packageComponentValue,
  SetupFailedError,
  type EffectiveFixtures,
} from "./local";
import { parseAppSource, SourceParseError, type AppSource } from "./sources";

export type RemoteEnv = Exclude<TargetEnv, "local">;

/** GraphQL registries per target (mirrors src/env.ts REGISTRY_*; declared
 * here so loading a scenario never pulls the heavy src/ dependency tree). */
export const REMOTE_REGISTRIES: Record<RemoteEnv, string> = {
  dev: "https://registry.wasmer.wtf/graphql",
  bugtopia: "https://registry.wasmer.fun/graphql",
  prod: "https://registry.wasmer.io/graphql",
};

/** Everything Phase 5 needs from a deployed app, shaped so tests can fake the
 * whole remote surface without a token. */
export interface RemoteApp {
  /** `<namespace>/<name>` — the identifier teardown failures are named by. */
  ident: string;
  id: string;
  url: string;
}

/** The narrow slice of TestEnv the remote resolver consumes. The real
 * implementation wraps TestEnv lazily; tests inject a fake. */
export interface RemotePlatform {
  registry: string;
  namespace: string;
  /** Env the executor is spawned with (registry/namespace/token/domain). */
  execEnv(): Record<string, string>;
  deployPackageApp(opts: {
    /** Registry ident, or an absolute directory to publish first. */
    source: string;
    /** D13: `max_instances: 1` maps to scaling mode single_concurrency. */
    singleConcurrency: boolean;
  }): Promise<RemoteApp>;
  deleteApp(app: RemoteApp): Promise<void>;
  /** `wasmer app logs` over the D14 window; returns raw log lines. */
  appLogs(
    app: RemoteApp,
    opts: { fromMs: number; stream?: "stdout" | "stderr" },
  ): Promise<string>;
  /** GET a deployed probe and return the response body. */
  fetchBody(url: string, timeoutMs: number): Promise<string>;
}

export interface RemoteResolveDeps {
  platform?: (env: RemoteEnv) => Promise<RemotePlatform>;
  io?: { info: (line: string) => void };
  now?: () => number;
}

/** Missing/rejected identity, restated with both ways out. Extracted so the
 * seam test can hold the message to "actionable" without a live registry. */
export function authFailureMessage(env: RemoteEnv, detail: string): string {
  return (
    `cannot authenticate against ${env} (${REMOTE_REGISTRIES[env]}): ` +
    `${detail}\nSet WASMER_TOKEN, or log in once with ` +
    `wasmer login --registry ${REMOTE_REGISTRIES[env].replace("/graphql", "")}`
  );
}

/** Real TestEnv-backed platform. Loaded lazily (same reason as deploy.ts):
 * TestEnv.fromEnv() reads process.env, so the target registry is installed
 * there first — this process is a single-run CLI, not a library. */
async function realPlatform(env: RemoteEnv): Promise<RemotePlatform> {
  const target = REMOTE_REGISTRIES[env];
  // The local-platform test env leaks into interactive shells
  // (WASMER_REGISTRY=http://localhost:18000 plus its token, namespace and
  // EDGE_* endpoints). Ambient identity survives only when it was set for
  // this exact registry; anything bound to a different one is dropped so
  // TestEnv falls back to the per-registry token in ~/.wasmer/wasmer.toml.
  if (process.env["WASMER_REGISTRY"] !== target) {
    delete process.env["WASMER_TOKEN"];
    delete process.env["WASMER_NAMESPACE"];
  }
  process.env["WASMER_REGISTRY"] = target;
  delete process.env["WASMER_APP_DOMAIN"];
  for (const stale of ["EDGE_SERVER", "EDGE_SSH_SERVER", "EDGE_DNS_SERVER"]) {
    delete process.env[stale];
  }
  const { TestEnv } = await import("../../src/index");
  let testEnv: import("../../src/index").TestEnv;
  try {
    testEnv = TestEnv.fromEnv();
  } catch (err) {
    throw new SetupFailedError(
      authFailureMessage(env, err instanceof Error ? err.message : String(err)),
    );
  }
  return {
    registry: testEnv.registry,
    namespace: testEnv.namespace,
    execEnv: () => ({
      WASMER_REGISTRY: testEnv.registry,
      WASMER_NAMESPACE: testEnv.namespace,
      WASMER_TOKEN: testEnv.token,
      WASMER_APP_DOMAIN: testEnv.appDomain,
    }),
    deployPackageApp: async ({ source, singleConcurrency }) => {
      const { AppYaml } = await import("../../src/app/construct");
      const { randomAppName } = await import("../../src/index");
      const scaling = singleConcurrency
        ? { scaling: { mode: "single_concurrency" as const } }
        : {};
      let info: import("../../src/backend").AppInfo;
      if (path.isAbsolute(source)) {
        // A directory probe is usually a *nameless* package
        // (`wasmer.toml` with no [package] block), so it cannot be
        // published standalone; `wasmer deploy` with `package: "."`
        // publishes and deploys it in one step — the same shape the
        // hand-written app.yaml files used.
        const { cpSync, mkdtempSync, rmSync, writeFileSync } = await import(
          "node:fs"
        );
        const os = await import("node:os");
        const dir = mkdtempSync(path.join(os.tmpdir(), "ass-probe-"));
        try {
          cpSync(source, dir, { recursive: true });
          // JSON is valid YAML; app.yaml stays the product's format.
          writeFileSync(
            path.join(dir, "app.yaml"),
            JSON.stringify(
              AppYaml.parse({
                kind: "wasmer.io/App.v0",
                name: randomAppName(),
                owner: testEnv.namespace,
                package: ".",
                ...scaling,
              }),
              null,
              2,
            ),
          );
          info = await testEnv.deployAppDir(dir);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      } else {
        info = await testEnv.deployApp({
          appYaml: AppYaml.parse({
            kind: "wasmer.io/App.v0",
            package: source,
            ...scaling,
          }),
        });
      }
      // The app name is the URL's leftmost label (TestEnv names the app and
      // gives it `<name>.<appDomain>`); `wasmer app logs` addresses it as
      // `<namespace>/<name>`.
      const name = info.url.split("//")[1]?.split(".")[0] ?? info.id;
      return {
        ident: `${testEnv.namespace}/${name}`,
        id: info.id,
        url: info.url,
      };
    },
    deleteApp: async (app) => {
      await testEnv.deleteApp(
        { id: app.id, url: app.url } as Parameters<
          import("../../src/index").TestEnv["deleteApp"]
        >[0],
        { immediate: true },
      );
    },
    appLogs: async (app, opts) => {
      const args = [
        "app",
        "logs",
        app.ident,
        "--from",
        String(Math.floor(opts.fromMs / 1000)),
        "--max",
        "1000",
      ];
      if (opts.stream !== undefined) {
        args.push("--streams", opts.stream);
      }
      const result = await testEnv.runWasmerCommand({
        args,
        quiet: true,
        noAssertSuccess: true,
      });
      if (result.code !== 0) {
        throw new Error(
          `wasmer app logs ${app.ident} exited ${result.code}: ${result.stderr}`,
        );
      }
      return result.stdout;
    },
    fetchBody: async (url, timeoutMs) => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(
          `GET ${url} responded ${response.status}: ${body.slice(0, 300)}`,
        );
      }
      return body;
    },
  };
}

const PLATFORM_COMPONENTS = new Set(["edge", "backend"]);

/** TestEnv narrates its work through console.log/debug, which would tear the
 * presenter's single-voice frame. Every platform call runs with the console
 * redirected into a capture file next to the run's other raw logs; the
 * presenter keeps narrating the transitions itself. */
function quietPlatform(
  platform: RemotePlatform,
  logFile: string,
): RemotePlatform {
  const wrap = <A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      const original = {
        log: console.log,
        debug: console.debug,
        info: console.info,
      };
      const sink = (...parts: unknown[]): void => {
        try {
          appendFileSync(logFile, `${parts.map(String).join(" ")}\n`);
        } catch {
          // Losing narration must never fail the platform call itself.
        }
      };
      console.log = sink;
      console.debug = sink;
      console.info = sink;
      try {
        return await fn(...args);
      } finally {
        console.log = original.log;
        console.debug = original.debug;
        console.info = original.info;
      }
    };
  };
  return {
    registry: platform.registry,
    namespace: platform.namespace,
    execEnv: platform.execEnv,
    deployPackageApp: wrap(platform.deployPackageApp),
    deleteApp: wrap(platform.deleteApp),
    appLogs: wrap(platform.appLogs),
    fetchBody: wrap(platform.fetchBody),
  };
}

/** D13 on remote targets: `max_instances: 1` is honorable (app scaling mode
 * single_concurrency); any larger bound has no remote knob, so it fails
 * preflight — before any fixture work — rather than silently degrading into
 * a structurally false-negative reproduction. */
export function preflightRemoteConfig(scenario: Scenario, env: string): void {
  const offending = [
    ...Object.entries(scenario.fixtures.apps ?? {}),
    ...Object.entries(scenario.fixtures.probes ?? {}),
  ].filter(([, fixture]) => {
    const max = fixture.config?.max_instances;
    return max !== undefined && max !== 1;
  });
  if (offending.length > 0) {
    throw new PreflightError(
      "no fixtures were resolved:\n" +
        offending
          .map(
            ([name, fixture]) =>
              `  fixture "${name}" declares config.max_instances: ` +
              `${fixture.config?.max_instances}, which target "${env}" ` +
              "cannot honor (remote scaling supports exactly " +
              "max_instances: 1 via single_concurrency); D13 forbids " +
              "running it degraded",
          )
          .join("\n"),
    );
  }
}

/** The fixtures the active profile actually consumes: only referenced
 * probes/apps deploy, so an unused declaration costs nothing remotely. */
export function fixturesNeedingDeployment(
  scenario: Scenario,
  profileName: string,
): Set<string> {
  const wanted = new Set<string>();
  const profile = scenario.load.profiles[profileName] ?? {};
  for (const reference of templateReferences(profile)) {
    const check = checkReference(scenario, reference);
    if (check.problem === null && check.needsDeployment) {
      wanted.add(reference.split(".")[0]);
    }
  }
  return wanted;
}

export async function resolveRemote(
  scenario: Scenario,
  scenarioDir: string,
  effective: EffectiveFixtures,
  env: RemoteEnv,
  repoDir: string,
  deps: RemoteResolveDeps = {},
): Promise<ResolvedState> {
  const io = deps.io ?? {
    info: (line: string) => process.stderr.write(`${line}\n`),
  };
  const components: Record<string, string> = {};
  const pins: Record<string, string> = {};
  const variables: Record<string, string> = {};
  const platformDeclared: string[] = [];
  for (const [name, selector] of Object.entries(effective.components)) {
    if (PLATFORM_COMPONENTS.has(name)) {
      platformDeclared.push(name);
      components[name] = `remote:${env}`;
      pins[name] = `remote:${env}`;
      continue;
    }
    const value = packageComponentValue(selector, scenarioDir);
    components[name] = value;
    pins[name] = selector;
    variables[`component.${name}`] = value;
  }
  if (platformDeclared.length > 0) {
    io.info(
      `platform component(s) ${platformDeclared.sort().join(", ")} cannot ` +
        `be pinned on "${env}" — the run uses whatever the target currently ` +
        "runs, and is assessed in floating mode",
    );
  }

  // Parse every source before deploying anything, so a bad declaration
  // fails before the first remote mutation.
  const probeSources: Array<[string, AppSource, boolean]> = [];
  const appSources: Array<[string, AppSource, boolean]> = [];
  try {
    for (const [name, fixture] of Object.entries(
      scenario.fixtures.probes ?? {},
    )) {
      probeSources.push([
        name,
        parseAppSource(name, fixture.source),
        fixture.config?.max_instances === 1,
      ]);
    }
    for (const [name, fixture] of Object.entries(
      scenario.fixtures.apps ?? {},
    )) {
      appSources.push([
        name,
        parseAppSource(name, fixture.source),
        fixture.config?.max_instances === 1,
      ]);
    }
  } catch (err) {
    if (err instanceof SourceParseError) {
      throw new SetupFailedError(err.message);
    }
    throw err;
  }
  for (const [name, source] of [...probeSources, ...appSources]) {
    if (source.kind === "backup") {
      throw new SetupFailedError(
        `fixture "${name}": backup: sources require BE-666 (D4, still ` +
          "blocked); non-backup remote scenarios are unaffected",
      );
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactsDir = path.join(
    repoDir,
    ".local-platform",
    "ass",
    "runs",
    stamp,
  );
  mkdirSync(artifactsDir, { recursive: true });

  const platform = quietPlatform(
    await (deps.platform ?? realPlatform)(env),
    path.join(artifactsDir, "remote-setup.log"),
  );
  const needed = fixturesNeedingDeployment(scenario, effective.executor);

  const deployed: RemoteApp[] = [];
  const deployedByFixture: Record<string, RemoteApp> = {};
  const cleanup = async (): Promise<string[]> => {
    const errors: string[] = [];
    for (const app of deployed) {
      try {
        await platform.deleteApp(app);
      } catch (err) {
        errors.push(
          `leaked probe app ${app.ident} (${app.url}): could not delete — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return errors;
  };

  try {
    for (const [name, source, single] of probeSources) {
      // Path/package affordances resolve like local; `.url`/`.app_id` deploy.
      if (source.kind === "package" && source.ref.startsWith("./")) {
        variables[`${name}.path`] = path.join(scenarioDir, source.ref);
      } else if (source.kind === "package") {
        variables[`${name}.package`] = source.ref;
      } else if (source.kind === "fixture") {
        variables[`${name}.path`] = path.join(scenarioDir, source.path);
      }
      if (!needed.has(name)) {
        continue;
      }
      if (source.kind !== "package") {
        throw new SetupFailedError(
          `probe fixture "${name}": only package: sources deploy remotely ` +
            `(got ${source.kind}:)`,
        );
      }
      io.info(`deploying probe fixture "${name}" to ${env}`);
      const app = await platform.deployPackageApp({
        source: source.ref.startsWith("./")
          ? path.join(scenarioDir, source.ref)
          : source.ref,
        singleConcurrency: single,
      });
      deployed.push(app);
      deployedByFixture[name] = app;
      variables[`${name}.url`] = app.url;
      variables[`${name}.app_id`] = app.id;
      io.info(`probe "${name}" deployed: ${app.url}`);
    }
    for (const [name, source, single] of appSources) {
      if (!needed.has(name)) {
        continue;
      }
      if (source.kind !== "package") {
        throw new SetupFailedError(
          `app fixture "${name}": only package: sources deploy remotely in ` +
            `v1 (got ${source.kind}:)`,
        );
      }
      io.info(`deploying app fixture "${name}" to ${env}`);
      const app = await platform.deployPackageApp({
        source: source.ref.startsWith("./")
          ? path.join(scenarioDir, source.ref)
          : source.ref,
        singleConcurrency: single,
      });
      deployed.push(app);
      deployedByFixture[name] = app;
      variables[`${name}.url`] = app.url;
      variables[`${name}.app_id`] = app.id;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const cleanupErrors = await cleanup();
    throw err instanceof SetupFailedError && err.cleanupErrors.length === 0
      ? new SetupFailedError(detail, cleanupErrors)
      : new SetupFailedError(
          `deploying fixtures to ${env} failed: ${detail}`,
          cleanupErrors,
        );
  }

  return {
    env,
    variables,
    components,
    pins,
    execEnv: platform.execEnv(),
    artifactsDir,
    composeLogPath: null,
    cleanup,
    remote: { platform, deployed: deployedByFixture },
  };
}
