// Shared helpers for the ASS loader/CLI tests: disposable scenario trees and
// an io-capturing CLI runner. Everything stays inside a mkdtemp directory —
// the repo's real experiments/ and repros/ are never touched.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "../../ass/cli";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

export function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ass-test-"));
  roots.push(root);
  return root;
}

export function addScenario(
  root: string,
  boundary: "experiments" | "repros",
  slug: string,
  yaml: string,
): string {
  const dir = path.join(root, boundary, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "scenario.yaml"), yaml);
  return dir;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function cli(
  root: string,
  argv: string[],
  runnerDeps?: import("../../ass/engine/runner").RunnerDeps,
  doctor?: import("../../ass/cli").CliOptions["doctor"],
): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd: root,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    // Assertions here read the CLI's words, not its styling. CI exports
    // FORCE_COLOR=1 for jest, which would otherwise smear SGR codes through
    // every substring match. Color itself is covered against the renderers.
    color: false,
    runnerDeps,
    doctor,
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** File contents under `root`, optionally restricted to a few subtrees (a run
 * legitimately writes reports and try-state elsewhere in the tree). */
export function snapshotTree(
  root: string,
  subpaths: string[] = ["."],
): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        snapshot[path.relative(root, full)] = readFileSync(full, "utf8");
      }
    }
  };
  for (const subpath of subpaths) {
    walk(path.join(root, subpath));
  }
  return snapshot;
}

export const DRAFT_YAML = `
meta:
  id: EXP-1
  title: an in-progress draft
fixtures:
  components:
    edge: resolve_prod
load:
  executor: jest
  jest:
    spec: tests/app/templates.test.ts
`;

/** A draft that is ready to graduate: floating edge, a verdict, and a waived
 * baseline (D10). Its comment is what proves promotion is a text edit. */
export const PROMOTABLE_DRAFT_YAML = `
meta:
  id: WAX-999
  title: a draft that reproduces
fixtures:
  components:
    # floating on purpose while hunting
    edge: resolve_prod
load:
  executor: jest
  jest:
    spec: tests/app/templates.test.ts
verdict:
  reproduced_when:
    any:
      - log_matches:
          stream: edge
          pattern: object used with the wrong context
  baseline:
    waived: platform-level bug - no native analogue
`;

export const PERSISTED_YAML = `
meta:
  id: WAX-600
  title: Edge wasix cross-Store panic under CPU starvation
  lifecycle: { state: open }
  links:
    linear: https://linear.app/wasmer/issue/WAX-600
fixtures:
  apps:
    victim:
      source: template:next-react-server-components
  components:
    edge: github-release:wasmerio/edge:v2026-07-16_1_fcdd9c4_dev1:edge
    backend: "github-release:wasmerio/backend:v2026-07-15_2_9a6c3d4:*image*.tar*"
  perturbations:
    edge: { cpus: 1, wipe_caches: [compiler_cache, webc_cache] }
load:
  executor: jest
  jest:
    spec: tests/app/templates.test.ts
    testNamePattern: next-react-server-components
verdict:
  reproduced_when:
    any:
      - log_matches:
          stream: edge
          pattern: object used with the wrong context
  baseline:
    waived: platform-level bug - no native analogue
`;

// -- fake execution harness (Phase 2) ---------------------------------------
// A run needs a platform driver, an app deployer, and a workload exec; the
// fakes stay entirely inside a mkdtemp run dir and record the call sequence
// so tests can assert setup-precedes-workload and cleanup behavior.

import type { PlatformDriver } from "../../ass/fixtures/localPlatform";
import type { RunnerDeps } from "../../ass/engine/runner";
import type { RemotePlatform } from "../../ass/fixtures/remote";

export interface FakeHarness {
  deps: RunnerDeps;
  runDir: string;
  calls: string[];
  /** Content the fake stack "logs" for edge/backend during the run. */
  composeLog: string;
  workload: {
    code: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
  };
  failUp?: string;
  failDown?: string;
  restoreErrors?: string[];
  /** Fires inside up(), before it succeeds or fails: the seam a test uses to
   * interrupt a boot in progress. */
  onUp?: () => void;
  /** Extra env the state manager passed to the last up() call. */
  upEnv?: Record<string, string>;
  /** What the fake remote target "logs" for a deployed app (D14 pull). */
  remoteLogs: string;
  /** What the fake deployed probe answers over HTTP. */
  remoteBody: string;
  failRemoteDeploy?: string;
  failRemoteDelete?: string;
  /** The `fromMs` values `appLogs` was called with (D14 window assertions). */
  appLogsFrom: number[];
  /** Whether the prod confirmation (never a real prompt in tests) approves. */
  confirmProdAnswer?: boolean;
}

export function makeFakeHarness(
  options: Partial<
    Pick<
      FakeHarness,
      | "composeLog"
      | "workload"
      | "failUp"
      | "failDown"
      | "restoreErrors"
      | "onUp"
      | "remoteLogs"
      | "remoteBody"
      | "failRemoteDeploy"
      | "failRemoteDelete"
      | "confirmProdAnswer"
    >
  > = {},
): FakeHarness {
  const runDir = mkdtempSync(path.join(tmpdir(), "ass-fake-run-"));
  roots.push(runDir);
  const calls: string[] = [];
  const harness: FakeHarness = {
    runDir,
    calls,
    composeLog:
      options.composeLog ??
      "edge-1  | thread 'tokio' panicked at store.rs:1:\n" +
        "edge-1  | object used with the wrong context\n",
    workload: options.workload ?? { code: 1, stdout: "jest ran\n", stderr: "" },
    failUp: options.failUp,
    failDown: options.failDown,
    restoreErrors: options.restoreErrors,
    onUp: options.onUp,
    remoteLogs: options.remoteLogs ?? "",
    remoteBody: options.remoteBody ?? "",
    failRemoteDeploy: options.failRemoteDeploy,
    failRemoteDelete: options.failRemoteDelete,
    appLogsFrom: [],
    confirmProdAnswer: options.confirmProdAnswer,
    deps: undefined as unknown as RunnerDeps,
  };
  let running = false;
  const driver: PlatformDriver = {
    repoDir: runDir,
    applyPins: (pins) => {
      calls.push(
        `pins:${Object.entries(pins)
          .map(([k, v]) => `${k}=${v}`)
          .sort()
          .join(",")}`,
      );
    },
    applyCpus: (service, cpus) => {
      calls.push(`cpus:${service}=${cpus}`);
    },
    wipeCaches: (service, names) => {
      calls.push(`wipe:${service}:${names.join(",")}`);
    },
    restoreFiles: () => {
      calls.push("restore");
      return harness.restoreErrors ?? [];
    },
    up: async (extraEnv?: Record<string, string>) => {
      calls.push("up");
      harness.upEnv = extraEnv ?? {};
      harness.onUp?.();
      if (harness.failUp !== undefined) {
        throw new Error(harness.failUp);
      }
      running = true;
      mkdirSync(path.join(runDir, "logs"), { recursive: true });
      writeFileSync(
        path.join(runDir, "logs", "compose.follow.log"),
        harness.composeLog,
      );
      writeFileSync(
        path.join(runDir, "edge-platform-config.yaml"),
        "socket:\n  reuse_instance_max_instances_per_node: 1\n",
      );
    },
    down: async () => {
      calls.push("down");
      running = false;
      return harness.failDown ?? null;
    },
    currentRunDir: () => (running ? runDir : null),
    readTestEnv: () => ({ WASMER_REGISTRY: "http://localhost:1/graphql" }),
    // Shaped like the real resolved.env: EDGE_RESOLVED and
    // BACKEND_IMAGE_SOURCE are selectors, so a floating draft can be pinned
    // from them; BACKEND_IMAGE_REF is only a version for humans.
    readResolvedEnv: () => ({
      EDGE_RESOLVED:
        "github-release:wasmerio/edge:v2026-08-05_1_419b336_dev1:edge",
      BACKEND_IMAGE_REF: "stackmachine:v2026-08-03_1_c3252ee",
      BACKEND_IMAGE_SOURCE:
        "github-release:wasmerio/backend:v2026-08-03_1_c3252ee:*image*.tar*",
    }),
    composeFollowLogPath: () => path.join(runDir, "logs", "compose.follow.log"),
    edgePlatformConfigPath: () =>
      path.join(runDir, "edge-platform-config.yaml"),
  };
  const remotePlatform: RemotePlatform = {
    registry: "https://registry.fake.example/graphql",
    namespace: "fake-ns",
    execEnv: () => ({
      WASMER_REGISTRY: "https://registry.fake.example/graphql",
      WASMER_NAMESPACE: "fake-ns",
      WASMER_TOKEN: "fake-secret-token-do-not-serialize",
      WASMER_APP_DOMAIN: "fake.example",
    }),
    deployPackageApp: async ({ source, singleConcurrency }) => {
      const name = path.basename(source).replace(/[^a-z0-9-]/gi, "-");
      calls.push(`remote-deploy:${name}${singleConcurrency ? ":single" : ""}`);
      if (harness.failRemoteDeploy !== undefined) {
        throw new Error(harness.failRemoteDeploy);
      }
      return {
        ident: `fake-ns/${name}`,
        id: `da_${name}`,
        url: `https://${name}.fake.example`,
      };
    },
    deleteApp: async (app) => {
      calls.push(`remote-delete:${app.ident}`);
      if (harness.failRemoteDelete !== undefined) {
        throw new Error(harness.failRemoteDelete);
      }
    },
    appLogs: async (_app, opts) => {
      harness.appLogsFrom.push(opts.fromMs);
      calls.push(`remote-logs:${opts.stream ?? "app"}`);
      return harness.remoteLogs;
    },
    fetchBody: async (url) => {
      calls.push(`remote-fetch:${url}`);
      return harness.remoteBody;
    },
  };
  harness.deps = {
    driver,
    deployApp: async (name) => {
      calls.push(`deploy:${name}`);
      return {
        url: `https://${name}.localhost`,
        appId: `app-${name}`,
        dir: path.join(runDir, "apps", name),
      };
    },
    workloadExec: async (argv, opts) => {
      calls.push(`exec:${argv.join(" ")}`);
      writeFileSync(opts.stdoutFile, harness.workload.stdout);
      writeFileSync(opts.stderrFile, harness.workload.stderr);
      return {
        exitCode: harness.workload.code,
        timedOut: harness.workload.timedOut ?? false,
      };
    },
    remote: {
      platform: async (env) => {
        calls.push(`remote-platform:${env}`);
        return remotePlatform;
      },
    },
    // One pull, no polling: quiescence is exercised by its own unit test.
    capture: { quiescenceMs: 0, maxWaitMs: 0, pollMs: 0 },
    confirmProd: async () => {
      calls.push("confirm-prod");
      return harness.confirmProdAnswer ?? false;
    },
  };
  return harness;
}
