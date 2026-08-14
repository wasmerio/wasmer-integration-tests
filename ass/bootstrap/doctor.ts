// `ass doctor` — the machine-checkable convergence criterion for setup
// (docs/anti-slop-shield-v1.md §7). SETUP.md's terminal instruction is
// "iterate until `ass doctor` exits 0", so every check states what is missing
// *and* how to get it. Missing optional tools degrade a capability rather than
// blocking the harness: no Docker means no local target, not no ASS.
//
// Every probe goes through one injected process boundary, so the whole table
// is deterministic in tests without touching the developer's machine.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { makeStyle, type ColorName } from "../report/style";

export interface ProbeResult {
  status: number;
  stdout: string;
}

export type Probe = (argv: string[]) => ProbeResult;

export interface Capability {
  name: string;
  /** A required capability failing makes doctor exit non-zero. */
  required: boolean;
  ok: boolean;
  detail: string;
  /** What stops working while an optional capability is missing. */
  degrades?: string;
  remediation?: string;
}

export interface DoctorReport {
  capabilities: Capability[];
  /** True when every required capability passes. */
  ok: boolean;
}

export interface DoctorOptions {
  cwd: string;
  probe?: Probe;
  nodeVersion?: string;
  exists?: (target: string) => boolean;
  platform?: NodeJS.Platform;
}

const defaultProbe: Probe = (argv) => {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.error !== undefined ? 127 : (result.status ?? 1),
    stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
};

/** First `major.minor.patch`-ish run in a version banner. */
export function parseVersion(text: string): number[] | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return match === null
    ? null
    : [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function atLeast(found: number[], minimum: number[]): boolean {
  for (let i = 0; i < minimum.length; i++) {
    const a = found[i] ?? 0;
    const b = minimum[i];
    if (a !== b) {
      return a > b;
    }
  }
  return true;
}

/** Install hint tailored to what the machine already has, never acted upon —
 * `make ass` detects, the agent installs (§7). */
function installHint(probe: Probe, platform: NodeJS.Platform): string {
  if (probe(["nix", "--version"]).status === 0) {
    return "nix develop (the repo's flake.nix provides the toolchain)";
  }
  if (platform === "darwin") {
    return "brew install";
  }
  if (probe(["apt-get", "--version"]).status === 0) {
    return "sudo apt-get install";
  }
  return "your platform's package manager";
}

export function runDoctor(options: DoctorOptions): DoctorReport {
  const probe = options.probe ?? defaultProbe;
  const exists = options.exists ?? existsSync;
  const platform = options.platform ?? process.platform;
  const hint = installHint(probe, platform);
  const capabilities: Capability[] = [];

  const nodeVersion = options.nodeVersion ?? process.version;
  const node = parseVersion(nodeVersion);
  capabilities.push({
    name: "node >= 22",
    required: true,
    ok: node !== null && atLeast(node, [22]),
    detail: nodeVersion,
    // Also the `node` native baseline engine (D10); it is required anyway,
    // so its absence is never a mere degrade.
    remediation: `${hint} node 22 or newer (the repo's Makefile enforces the same floor)`,
  });

  const pnpm = probe(["pnpm", "--version"]);
  capabilities.push({
    name: "pnpm",
    required: true,
    ok: pnpm.status === 0,
    detail: pnpm.status === 0 ? pnpm.stdout.trim() : "not found",
    remediation: "corepack enable pnpm, or npm install -g pnpm",
  });

  const installed = exists(path.join(options.cwd, "node_modules"));
  capabilities.push({
    name: "dependencies installed",
    required: true,
    ok: installed,
    detail: installed ? "node_modules present" : "node_modules missing",
    remediation: "make setup (runs pnpm install)",
  });

  const python = probe(["python3", "--version"]);
  const pythonVersion = parseVersion(python.stdout);
  const pythonOk =
    python.status === 0 &&
    pythonVersion !== null &&
    atLeast(pythonVersion, [3, 12]);
  capabilities.push({
    name: "python3 >= 3.12",
    required: false,
    ok: pythonOk,
    detail: python.status === 0 ? python.stdout.trim() : "not found",
    degrades:
      "local-target runs (the local-platform CLI) — every target ASS can " +
      "currently run — and the python3 native baseline",
    remediation: `${hint} python3.12 or newer`,
  });

  const compose = probe(["docker", "compose", "version"]);
  const composeVersion = parseVersion(compose.stdout);
  const composeOk =
    compose.status === 0 &&
    composeVersion !== null &&
    atLeast(composeVersion, [2]);
  capabilities.push({
    name: "docker compose v2",
    required: false,
    ok: composeOk,
    detail: compose.status === 0 ? compose.stdout.trim() : "not found",
    // Local is the only target the engine runs today (remote lands in Phase
    // 5), so this degrade currently costs every run. Say that rather than
    // implying a remote fallback that does not exist yet (review 4, R4-03).
    degrades:
      "local-target runs (ass run --env local) — every target ASS can " +
      "currently run; remote targets land in Phase 5",
    remediation:
      "install Docker Engine with the compose v2 plugin (docs.docker.com/engine/install)",
  });

  const gh = probe(["gh", "auth", "status"]);
  capabilities.push({
    name: "github authenticated",
    required: false,
    ok: gh.status === 0,
    detail: gh.status === 0 ? "gh auth status ok" : "not authenticated",
    degrades:
      "pinned github-release: component selectors (release assets need a token)",
    remediation: "gh auth login --scopes repo",
  });

  const wasmer = probe(["wasmer", "-V"]);
  capabilities.push({
    name: "wasmer",
    required: false,
    ok: wasmer.status === 0,
    detail: wasmer.status === 0 ? wasmer.stdout.trim() : "not found",
    degrades:
      "raw-wasmer workloads (`wasmer run` against a package component); " +
      "a scenario can also select its own binary with binary: or WASMER_PATH",
    remediation: "curl https://get.wasmer.io -sSfL | sh",
  });

  // Native baselines (D10): each missing engine costs exactly its own
  // differential proof, nothing else.
  for (const [engine, argv] of [
    ["go", ["go", "version"]],
    ["cargo", ["cargo", "--version"]],
  ] as const) {
    const result = probe([...argv]);
    capabilities.push({
      name: `baseline engine: ${engine}`,
      required: false,
      ok: result.status === 0,
      detail: result.status === 0 ? result.stdout.trim() : "not found",
      degrades: `scenarios whose verdict.baseline declares engine: ${engine}`,
      remediation: `${hint} ${engine}`,
    });
  }

  return {
    capabilities,
    ok: capabilities.every(
      (capability) => !capability.required || capability.ok,
    ),
  };
}

export function formatDoctor(
  report: DoctorReport,
  options: { color?: boolean } = {},
): string[] {
  const s = makeStyle(options.color ?? false);
  const width = Math.max(...report.capabilities.map((c) => c.name.length)) + 2;
  const lines: string[] = [];
  for (const capability of report.capabilities) {
    const tone: ColorName = capability.ok
      ? "green"
      : capability.required
        ? "red"
        : "yellow";
    lines.push(
      `${s(capability.ok ? "✔" : "✖", tone)} ${capability.name.padEnd(width)}${capability.detail}`,
    );
    if (capability.ok) {
      continue;
    }
    if (capability.degrades !== undefined) {
      lines.push(`    unavailable: ${capability.degrades}`);
    }
    if (capability.remediation !== undefined) {
      lines.push(`    fix: ${capability.remediation}`);
    }
  }
  const missingRequired = report.capabilities.filter(
    (capability) => capability.required && !capability.ok,
  );
  const degraded = report.capabilities.filter(
    (capability) => !capability.required && !capability.ok,
  );
  lines.push(
    report.ok
      ? s(
          `ready${degraded.length > 0 ? ` (${degraded.length} capability degraded)` : ""}`,
          degraded.length > 0 ? "yellow" : "green",
        )
      : s(
          `missing required: ${missingRequired.map((c) => c.name).join(", ")}`,
          "red",
        ),
  );
  return lines;
}
