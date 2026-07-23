// raw-wasmer executor (QA-639, Artem's "pure wasmer" wishlist item): the
// workload is a `wasmer run` invocation against a caller-selected binary —
// the last hop of the investigation path before attaching a debugger.
//
// The binary is deliberately a knob rather than a component: verifying a
// runtime fix means running the *same* declaration against a locally built
// wasmer, and that is a caller decision (`binary:`, `--wasmer`, WASMER_PATH),
// not an edit to the scenario. The package under test *is* a component, so
// `--component python=path:…` swaps the interpreter exactly as the WAX-603
// script's PYTHON_PKG did.

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import {
  profileError,
  type Executor,
  type ExecuteContext,
  type ResolvedState,
  type RunOutcome,
} from "./contract";
import { PreflightError } from "../errors";
import { runCaptured } from "./process";
import { interpolate } from "./template";

export const rawWasmerProfileSchema = z.strictObject({
  /** Registry identifier or directory containing a wasmer.toml. */
  package: z.string().min(1),
  /** Arguments handed to the guest program, after `--`. */
  args: z.array(z.string()).optional(),
  /** Host path -> guest mount point, one `--volume host:guest` each. */
  volumes: z.record(z.string().min(1)).optional(),
  /** Guest environment, one `--env k=v` each. */
  env: z.record(z.string()).optional(),
  /** Extra `wasmer run` flags, inserted verbatim before `--`. */
  runArgs: z.array(z.string().min(1)).optional(),
  /** Which wasmer to run. Defaults to $WASMER_PATH, then `wasmer` on PATH. */
  binary: z.string().min(1).optional(),
  /** Harness backstop. A probe owns its own wall-clock bound; this only
   * catches the case where it does not come back at all (⇒ inconclusive). */
  timeoutSeconds: z.number().int().positive().default(300),
});
export type RawWasmerProfile = z.infer<typeof rawWasmerProfileSchema>;

export function parseRawWasmerProfile(
  profile: Record<string, unknown>,
): RawWasmerProfile {
  const parsed = rawWasmerProfileSchema.safeParse(profile);
  if (!parsed.success) {
    throw profileError("raw-wasmer", parsed.error);
  }
  return parsed.data;
}

/** Caller-selected binary, in precedence order. */
export function selectBinary(
  profile: RawWasmerProfile,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return profile.binary ?? env["WASMER_PATH"] ?? "wasmer";
}

/** A selected binary that is a path must exist before a boot is spent on it;
 * a bare name is left to PATH lookup, which the spawn failure reports. */
export function preflightBinary(binary: string): void {
  if (!binary.includes("/")) {
    return;
  }
  if (!existsSync(binary)) {
    throw new PreflightError(
      `the raw-wasmer executor's selected wasmer binary "${binary}" does not ` +
        "exist; set binary: in the profile, WASMER_PATH, or install wasmer " +
        "(curl https://get.wasmer.io -sSfL | sh)",
    );
  }
}

export function buildArgv(profile: RawWasmerProfile, binary: string): string[] {
  const argv = [binary, "run", profile.package];
  for (const [host, guest] of Object.entries(profile.volumes ?? {})) {
    argv.push("--volume", `${host}:${guest}`);
  }
  for (const [name, value] of Object.entries(profile.env ?? {})) {
    argv.push("--env", `${name}=${value}`);
  }
  argv.push(...(profile.runArgs ?? []));
  if ((profile.args ?? []).length > 0) {
    argv.push("--", ...(profile.args ?? []));
  }
  return argv;
}

export async function executeRawWasmer(
  rawProfile: Record<string, unknown>,
  state: ResolvedState,
  ctx: ExecuteContext,
): Promise<RunOutcome> {
  const profile = parseRawWasmerProfile(
    interpolate(rawProfile, state.variables, "load.raw-wasmer"),
  );
  const binary = selectBinary(profile);
  preflightBinary(binary);
  // A `path:`-style package that is a directory is scenario-relative unless
  // it was already absolutized by fixture resolution.
  const pkg =
    profile.package.startsWith("./") || profile.package.startsWith("../")
      ? path.resolve(ctx.scenarioDir, profile.package)
      : profile.package;

  return runCaptured({
    argv: buildArgv({ ...profile, package: pkg }, binary),
    cwd: ctx.repoDir,
    env: state.execEnv,
    timeoutSeconds: profile.timeoutSeconds,
    artifactsDir: state.artifactsDir,
    label: ctx.label ?? "workload",
    exec: ctx.exec,
    onLine: ctx.onLine,
  });
}

export const rawWasmerExecutor: Executor = {
  name: "raw-wasmer",
  probeChannels: ["log"],
  parseProfile: (raw) => {
    const profile = parseRawWasmerProfile(raw);
    // `binary:` is declaration data, so it is checkable before fixtures
    // resolve; a templated one is not, and is checked at execute time.
    if (profile.binary !== undefined && !profile.binary.includes("{{")) {
      preflightBinary(selectBinary(profile));
    }
  },
  execute: executeRawWasmer,
};
