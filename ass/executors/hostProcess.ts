// host-process micro-executor (D8/D10): spawn a native engine and capture it.
// This is what makes the differential proof mechanical — nearly every Wasmer
// bug is a native-vs-guest divergence, so the same probe that runs under
// `wasmer run` also runs on the host toolchain, emits the same ASS-VERDICT
// line, and the two are compared instead of argued about.
//
// `engine:` names a toolchain rather than a command so a scenario does not
// encode one machine's invocation conventions; `binary` is the escape hatch
// for anything the list does not cover.

import path from "node:path";
import { z } from "zod";
import {
  profileError,
  type Executor,
  type ExecuteContext,
  type ResolvedState,
  type RunOutcome,
} from "./contract";
import { runCaptured } from "./process";
import { interpolate } from "./template";
import { BASELINE_ENGINES } from "../scenario/schema";

export type BaselineEngine = (typeof BASELINE_ENGINES)[number];

export const hostProcessProfileSchema = z.strictObject({
  engine: z.enum(BASELINE_ENGINES),
  /** Required for engine "binary"; rejected otherwise (schema enforces it on
   * the declaration side too). */
  command: z.array(z.string().min(1)).min(1).optional(),
  entry: z.array(z.string().min(1)).min(1),
  workdir: z.string().min(1).optional(),
  env: z.record(z.string()).optional(),
  timeoutSeconds: z.number().int().positive().default(300),
});
export type HostProcessProfile = z.infer<typeof hostProcessProfileSchema>;

export function parseHostProcessProfile(
  profile: Record<string, unknown>,
): HostProcessProfile {
  const parsed = hostProcessProfileSchema.safeParse(profile);
  if (!parsed.success) {
    throw profileError("host-process", parsed.error);
  }
  return parsed.data;
}

/** How each engine is invoked, and how `ass doctor` proves it is installed. */
const ENGINE_CONVENTIONS: Record<
  BaselineEngine,
  { run: (entry: string[]) => string[]; probe: string[] }
> = {
  python3: { run: (entry) => ["python3", ...entry], probe: ["python3", "-V"] },
  node: { run: (entry) => ["node", ...entry], probe: ["node", "--version"] },
  go: { run: (entry) => ["go", "run", ...entry], probe: ["go", "version"] },
  cargo: {
    run: (entry) => ["cargo", "run", "--quiet", ...entry],
    probe: ["cargo", "--version"],
  },
  // `binary` carries its own command; the probe is the command itself, which
  // spawn reports on when it is absent.
  binary: { run: (entry) => entry, probe: [] },
};

export function engineProbeArgv(engine: BaselineEngine): string[] {
  return [...ENGINE_CONVENTIONS[engine].probe];
}

export function buildEngineArgv(profile: HostProcessProfile): string[] {
  if (profile.engine === "binary") {
    return [...(profile.command ?? []), ...profile.entry];
  }
  return ENGINE_CONVENTIONS[profile.engine].run(profile.entry);
}

export async function executeHostProcess(
  rawProfile: Record<string, unknown>,
  state: ResolvedState,
  ctx: ExecuteContext,
): Promise<RunOutcome> {
  const profile = parseHostProcessProfile(
    interpolate(rawProfile, state.variables, "host-process"),
  );
  const workdir =
    profile.workdir === undefined
      ? ctx.scenarioDir
      : path.resolve(ctx.scenarioDir, profile.workdir);

  return runCaptured({
    argv: buildEngineArgv(profile),
    cwd: workdir,
    env: { ...state.execEnv, ...(profile.env ?? {}) },
    timeoutSeconds: profile.timeoutSeconds,
    artifactsDir: state.artifactsDir,
    label: ctx.label ?? "host-process",
    exec: ctx.exec,
    onLine: ctx.onLine,
  });
}

export const hostProcessExecutor: Executor = {
  name: "host-process",
  probeChannels: ["log"],
  parseProfile: (raw) => void parseHostProcessProfile(raw),
  execute: executeHostProcess,
};
