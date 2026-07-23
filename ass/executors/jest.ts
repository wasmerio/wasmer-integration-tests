// Jest executor (QA-637): run an existing Jest suite as the measured workload
// against a ResolvedState. The suite library in tests/ is the reason ASS lives
// in this repo, so "the workload is a test we already have" is a first-class
// executor rather than a shell-out.

import { z } from "zod";
import {
  ExecutorProfileError,
  profileError,
  type Executor,
  type ExecuteContext,
  type ResolvedState,
  type RunOutcome,
} from "./contract";
import { runCaptured } from "./process";
import { interpolate } from "./template";

export const jestProfileSchema = z.strictObject({
  spec: z.string().min(1),
  testNamePattern: z.string().min(1).optional(),
  /** Extra Jest CLI arguments, appended verbatim. */
  args: z.array(z.string().min(1)).optional(),
  /** Hard workload timeout; mirrors LOCAL_PLATFORM_TEST_TIMEOUT_SECONDS. */
  timeoutSeconds: z.number().int().positive().default(1200),
});
export type JestProfile = z.infer<typeof jestProfileSchema>;

export { ExecutorProfileError };

export function parseJestProfile(
  profile: Record<string, unknown>,
): JestProfile {
  const parsed = jestProfileSchema.safeParse(profile);
  if (!parsed.success) {
    throw profileError("jest", parsed.error);
  }
  return parsed.data;
}

export async function executeJest(
  rawProfile: Record<string, unknown>,
  state: ResolvedState,
  ctx: ExecuteContext,
): Promise<RunOutcome> {
  const profile = parseJestProfile(
    interpolate(rawProfile, state.variables, "load.jest"),
  );

  const argv = ["pnpm", "exec", "jest", profile.spec];
  if (profile.testNamePattern !== undefined) {
    argv.push("-t", profile.testNamePattern);
  }
  argv.push(...(profile.args ?? []));

  return runCaptured({
    argv,
    cwd: ctx.repoDir,
    env: state.execEnv,
    timeoutSeconds: profile.timeoutSeconds,
    artifactsDir: state.artifactsDir,
    label: ctx.label ?? "workload",
    exec: ctx.exec,
    onLine: ctx.onLine,
  });
}

export const jestExecutor: Executor = {
  name: "jest",
  probeChannels: ["log"],
  parseProfile: (raw) => void parseJestProfile(raw),
  execute: executeJest,
};
