// artillery-http executor (QA-638, D2): ASS owns the outer scenario file and
// embeds an Artillery-native block. Phases, flows, thresholds and plugins are
// Artillery's own vocabulary — inventing a second HTTP DSL would mean
// re-teaching every load-shaping concept Artillery already has, and would
// strand the ECO-403 WordPress work (loadtest/wordpress) that already speaks
// it. What ASS adds is fixture interpolation ({{ victim.url }}), the common
// RunOutcome, and threshold results as verdict inputs rather than a bare
// exit code.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dump as dumpYaml } from "js-yaml";
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

/** Artillery's own keys, passed through untouched. `config`/`scenarios` is
 * the native shape; the flat spelling is sugar that assembles `config` for
 * the common case of "a target, some phases, one flow". */
export const artilleryProfileSchema = z
  .strictObject({
    config: z.record(z.unknown()).optional(),
    scenarios: z.array(z.record(z.unknown())).min(1),
    target: z.string().min(1).optional(),
    phases: z.array(z.record(z.unknown())).min(1).optional(),
    /** Artillery thresholds; failures become verdict input, not a crash. */
    ensure: z.record(z.unknown()).optional(),
    http: z.record(z.unknown()).optional(),
    plugins: z.record(z.unknown()).optional(),
    variables: z.record(z.unknown()).optional(),
    timeoutSeconds: z.number().int().positive().default(900),
  })
  .superRefine((profile, ctx) => {
    const flat = ["target", "phases", "ensure", "http", "plugins", "variables"];
    const used = flat.filter(
      (key) => profile[key as keyof typeof profile] !== undefined,
    );
    if (profile.config !== undefined && used.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `declare Artillery config either natively under config: or flat ` +
          `(${flat.join(", ")}), not both; found config: plus ${used.sort().join(", ")}`,
      });
      return;
    }
    if (profile.config === undefined && profile.target === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message:
          "artillery-http needs a target: (usually a resolved fixture, " +
          'e.g. target: "{{ victim.url }}") or a native config: block',
      });
    }
  });
export type ArtilleryProfile = z.infer<typeof artilleryProfileSchema>;

export function parseArtilleryProfile(
  profile: Record<string, unknown>,
): ArtilleryProfile {
  const parsed = artilleryProfileSchema.safeParse(profile);
  if (!parsed.success) {
    throw profileError("artillery-http", parsed.error);
  }
  return parsed.data;
}

/** The Artillery script ASS hands to `artillery run`. */
export function buildArtilleryScript(
  profile: ArtilleryProfile,
): Record<string, unknown> {
  if (profile.config !== undefined) {
    return { config: profile.config, scenarios: profile.scenarios };
  }
  const config: Record<string, unknown> = { target: profile.target };
  if (profile.phases !== undefined) {
    config["phases"] = profile.phases;
  } else {
    // A profile that shapes no load still has to run once; a missing phases
    // block otherwise makes Artillery exit having done nothing at all.
    config["phases"] = [{ duration: 1, arrivalCount: 1 }];
  }
  if (profile.ensure !== undefined) {
    config["ensure"] = profile.ensure;
  }
  if (profile.http !== undefined) {
    config["http"] = profile.http;
  }
  if (profile.variables !== undefined) {
    config["variables"] = profile.variables;
  }
  // Per-endpoint metrics by default: a load repro whose report cannot say
  // *which* URL degraded is a number without a finding. Thresholds are
  // enforced by Artillery's `ensure` plugin, which has to be listed — a
  // declared `ensure:` that silently never runs would report a passing load
  // test for a target that breached every threshold.
  config["plugins"] = {
    "metrics-by-endpoint": {},
    ...(profile.ensure === undefined ? {} : { ensure: {} }),
    ...(profile.plugins ?? {}),
  };
  return { config, scenarios: profile.scenarios };
}

interface ArtilleryReport {
  aggregate?: {
    counters?: Record<string, number>;
    summaries?: Record<string, Record<string, number>>;
  };
}

/** Artillery's JSON report, flattened into the common counter map. Threshold
 * results ride along as counters so a verdict can read them. */
export function readArtilleryCounters(
  reportPath: string,
): Record<string, number> {
  if (!existsSync(reportPath)) {
    return {};
  }
  let parsed: ArtilleryReport;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8")) as ArtilleryReport;
  } catch {
    return {};
  }
  const counters: Record<string, number> = {};
  for (const [name, value] of Object.entries(
    parsed.aggregate?.counters ?? {},
  )) {
    if (typeof value === "number") {
      counters[name] = value;
    }
  }
  for (const [name, summary] of Object.entries(
    parsed.aggregate?.summaries ?? {},
  )) {
    for (const [stat, value] of Object.entries(summary)) {
      if (typeof value === "number") {
        counters[`${name}.${stat}`] = value;
      }
    }
  }
  return counters;
}

export async function executeArtilleryHttp(
  rawProfile: Record<string, unknown>,
  state: ResolvedState,
  ctx: ExecuteContext,
): Promise<RunOutcome> {
  const profile = parseArtilleryProfile(
    interpolate(rawProfile, state.variables, "load.artillery-http"),
  );
  mkdirSync(state.artifactsDir, { recursive: true });
  const label = ctx.label ?? "workload";
  const scriptPath = path.join(state.artifactsDir, `${label}.artillery.yaml`);
  const reportPath = path.join(
    state.artifactsDir,
    `${label}.artillery-report.json`,
  );
  writeFileSync(scriptPath, dumpYaml(buildArtilleryScript(profile)));

  const outcome = await runCaptured({
    argv: [
      "pnpm",
      "exec",
      "artillery",
      "run",
      "--output",
      reportPath,
      scriptPath,
    ],
    cwd: ctx.repoDir,
    env: state.execEnv,
    timeoutSeconds: profile.timeoutSeconds,
    artifactsDir: state.artifactsDir,
    label,
    exec: ctx.exec,
    onLine: ctx.onLine,
  });
  // A failed `ensure:` threshold exits non-zero. That is a *result*, not a
  // harness error: the verdict decides what it means, and the counters below
  // are the evidence it decides on.
  outcome.counters = readArtilleryCounters(reportPath);
  outcome.logs["artillery-report"] = reportPath;
  // The generated script is what Artillery was actually given, interpolation
  // and all — the first thing to look at when a load run targets the wrong
  // thing.
  outcome.logs["artillery-script"] = scriptPath;
  return outcome;
}

export const artilleryHttpExecutor: Executor = {
  name: "artillery-http",
  // The probe's own output arrives in the response body, never in Artillery's
  // stderr — so this executor carries the http channel and not the log one.
  probeChannels: ["http"],
  parseProfile: (raw) => void parseArtilleryProfile(raw),
  execute: executeArtilleryHttp,
};
