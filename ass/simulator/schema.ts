// Simulator declaration schema v1 (business-simulator-v1 §4, worklog D-G):
// a distinct format from ASS's scenario.yaml, gated by `assSchema`. The
// object is strict and never declares `verdict`, so a verdict is
// structurally impossible (§2.1's "forbidden, not optional"), and an ASS
// scenario file fed to `up` is refused with a pointer at both formats.

import { readFileSync } from "node:fs";
import { load as parseYaml, YAMLException } from "js-yaml";
import { z, ZodError } from "zod";
import { FIXTURE_NAMES } from "./fixtures";

export const SUPPORTED_ASS_SCHEMA = 1;

export class SimulatorLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulatorLoadError";
  }
}

// -- duration / size grammars -----------------------------------------------

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const SIGNED_DURATION_RE = /^(-?\d+)(ms|s|m|h|d)$/;
const SIZE_RE = /^(\d+)(B|K|Ki|M|Mi|G|Gi)$/;

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const SIZE_UNIT_BYTES: Record<string, number> = {
  B: 1,
  K: 1000,
  Ki: 1024,
  M: 1000 ** 2,
  Mi: 1024 ** 2,
  G: 1000 ** 3,
  Gi: 1024 ** 3,
};

export function parseDurationMs(text: string): number {
  const match = SIGNED_DURATION_RE.exec(text);
  if (!match) {
    throw new Error(`not a duration: "${text}" (expected e.g. 90d, 2h, 45ms)`);
  }
  return Number(match[1]) * DURATION_UNIT_MS[match[2]];
}

export function parseSizeBytes(text: string): number {
  const match = SIZE_RE.exec(text);
  if (!match) {
    throw new Error(`not a size: "${text}" (expected e.g. 128Mi, 1G)`);
  }
  return Number(match[1]) * SIZE_UNIT_BYTES[match[2]];
}

const duration = z
  .string()
  .regex(DURATION_RE, "expected a duration like 90d, 2h, 30m or 45ms");
const signedDuration = z
  .string()
  .regex(
    SIGNED_DURATION_RE,
    "expected a (possibly negative) duration like -3d or 2h",
  );
const size = z.string().regex(SIZE_RE, "expected a size like 128Mi or 1G");

// -- blocks -----------------------------------------------------------------

const accountSchema = z.strictObject({
  username: z.string().min(1),
  password: z.string().min(1),
  namespace: z.string().min(1),
  /** The superuser lens: a pinned account's identity rows (user +
   * namespace) survive teardown, so a signed-in browser session outlives
   * scenario switches — scenarios swap the sub-state beneath one stable
   * customer. Default on; `pinned: false` restores full exact teardown
   * (the seeded e2e uses that to prove zero residue). */
  pinned: z.boolean().default(true),
});

/** Anchor-app fixture: one name, or a weighted mix — weights are relative
 * (normalized), e.g. `{ static-site: 10, php: 1, python: 3 }`. */
const fixtureName = z.enum(FIXTURE_NAMES);
const fixtureMix = z.union([
  fixtureName,
  z
    .record(fixtureName, z.number().positive())
    .refine((mix) => Object.keys(mix).length > 0, {
      message: "fixture mix must name at least one fixture",
    }),
]);

const appsSchema = z.strictObject({
  count: z.number().int().positive(),
  fixture: fixtureMix.default("static-site"),
  domains: z
    .strictObject({ custom: z.number().int().nonnegative() })
    .optional(),
  disks: z
    .strictObject({
      attached: z.number().int().nonnegative(),
      sizes: z.array(size).nonempty(),
    })
    .optional(),
  deployments: z
    .strictObject({
      perApp: z.number().int().positive(),
      failed: z.number().int().nonnegative().default(0),
    })
    .optional(),
});

const spikeSchema = z.strictObject({
  at: signedDuration,
  multiplier: z.number().positive(),
  duration: duration,
});

const burstSchema = z.strictObject({
  at: signedDuration,
  rate: z.number().min(0).max(1),
  duration: duration,
});

const telemetrySchema = z.strictObject({
  history: duration,
  rps: z.strictObject({
    base: z.number().positive(),
    spikes: z.array(spikeSchema).default([]),
    /** Per-app traffic multiplier, keyed by app name (seed-derived); apps
     * not listed keep their weighted share. */
    perApp: z.record(z.string(), z.number().positive()).default({}),
  }),
  errorRate: z
    .strictObject({
      base: z.number().min(0).max(1),
      bursts: z.array(burstSchema).default([]),
    })
    .default({ base: 0.001, bursts: [] }),
  latency: z
    .strictObject({ p50: duration, p95: duration, p99: duration })
    .default({ p50: "45ms", p95: "300ms", p99: "900ms" }),
  resources: z
    .strictObject({
      cpuMillisPerRequest: z
        .strictObject({
          mean: z.number().positive(),
          stddev: z.number().min(0),
        })
        .default({ mean: 12, stddev: 4 }),
      memoryBytes: z
        .strictObject({ mean: size, stddev: size })
        .default({ mean: "128Mi", stddev: "32Mi" }),
    })
    .default({
      cpuMillisPerRequest: { mean: 12, stddev: 4 },
      memoryBytes: { mean: "128Mi", stddev: "32Mi" },
    }),
  /** D-A row-budget override; the default lives in the telemetry seeder. */
  rowBudget: z.number().int().positive().optional(),
  /** Window (back from `up` time) that gets per-request raw rows; older
   * history is written as exact pre-aggregated rollups (D-A). */
  rawWindow: duration.default("48h"),
});

const billingSchema = z.strictObject({
  plan: z.string().min(1),
  subscription: z.enum(["active", "past_due", "canceled", "trialing"]),
  invoices: z
    .strictObject({
      count: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative().default(0),
    })
    .default({ count: 0, failed: 0 }),
  entitlements: z
    .strictObject({ computeConsumed: z.number().min(0).max(1) })
    .optional(),
});

const declarationSchema = z.strictObject({
  assSchema: z.literal(SUPPORTED_ASS_SCHEMA),
  name: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "scenario names are lowercase slugs (a-z, 0-9, -)",
    ),
  description: z.string().optional(),
  seed: z.number().int().nonnegative().optional(),
  account: accountSchema,
  apps: appsSchema.optional(),
  telemetry: telemetrySchema.optional(),
  billing: billingSchema.optional(),
});

export type SimulatorDeclaration = z.infer<typeof declarationSchema>;
export type AccountBlock = SimulatorDeclaration["account"];
export type AppsBlock = NonNullable<SimulatorDeclaration["apps"]>;
export type TelemetryBlock = NonNullable<SimulatorDeclaration["telemetry"]>;
export type BillingBlock = NonNullable<SimulatorDeclaration["billing"]>;

export function formatIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  ${path}: ${issue.message}`;
    })
    .join("\n");
}

export interface LoadedDeclaration {
  declaration: SimulatorDeclaration;
  /** The path as given on the CLI; recorded in the descriptor. */
  path: string;
  /** Raw file text plus a canonical rendering of any `--set` overrides;
   * digested for D-I reseed detection. */
  raw: string;
  /** The applied `--set` overrides, canonically sorted. */
  overrides: Record<string, string>;
}

/** One `--set path=value` override: tweak a scenario without editing the
 * file (the D12 discipline — overrides never edit the declaration). Values
 * parse as YAML scalars; paths are dot-separated, quoted-at-will segments
 * (`telemetry.rps.perApp.quiet-harbor-11=2`). */
export function parseOverride(text: string): {
  path: string[];
  value: unknown;
} {
  const eq = text.indexOf("=");
  if (eq <= 0 || eq === text.length - 1) {
    throw new SimulatorLoadError(
      `--set expects <dot.path>=<value>, got "${text}"`,
    );
  }
  const path = text
    .slice(0, eq)
    .split(".")
    .map((segment) => segment.trim());
  if (path.some((segment) => segment === "")) {
    throw new SimulatorLoadError(`--set path has an empty segment: "${text}"`);
  }
  let value: unknown;
  try {
    value = parseYaml(text.slice(eq + 1));
  } catch {
    value = text.slice(eq + 1);
  }
  return { path, value };
}

function applyOverride(
  target: Record<string, unknown>,
  path: string[],
  value: unknown,
  origin: string,
): void {
  let node: Record<string, unknown> = target;
  for (const segment of path.slice(0, -1)) {
    const next = node[segment];
    if (next === undefined || next === null) {
      const created: Record<string, unknown> = {};
      node[segment] = created;
      node = created;
    } else if (typeof next === "object" && !Array.isArray(next)) {
      node = next as Record<string, unknown>;
    } else {
      throw new SimulatorLoadError(
        `--set ${origin}: "${segment}" is not an object in the scenario`,
      );
    }
  }
  node[path[path.length - 1]] = value;
}

export function parseDeclaration(
  raw: string,
  sourcePath: string,
): SimulatorDeclaration {
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    const detail = err instanceof YAMLException ? err.message : String(err);
    throw new SimulatorLoadError(`${sourcePath}: invalid YAML: ${detail}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new SimulatorLoadError(
      `${sourcePath}: expected a YAML mapping at the top level`,
    );
  }
  const record = data as Record<string, unknown>;
  if (!("assSchema" in record)) {
    throw new SimulatorLoadError(
      `${sourcePath}: no assSchema key — this is not a simulator ` +
        "declaration. Simulator files (ass up/down) declare " +
        `\`assSchema: ${SUPPORTED_ASS_SCHEMA}\`; ASS reproduction scenarios ` +
        "(meta/fixtures/load/verdict) run with `ass try`/`ass run` instead.",
    );
  }
  if (record["assSchema"] !== SUPPORTED_ASS_SCHEMA) {
    throw new SimulatorLoadError(
      `${sourcePath}: unsupported assSchema ` +
        `${JSON.stringify(record["assSchema"])}; this ass build supports ` +
        `assSchema: ${SUPPORTED_ASS_SCHEMA}. A newer scenario needs a newer ` +
        "integration-tests submodule (or the scenario file predates it).",
    );
  }
  try {
    return declarationSchema.parse(record);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new SimulatorLoadError(
        `${sourcePath}: invalid simulator declaration:\n${formatIssues(err)}`,
      );
    }
    throw err;
  }
}

export function loadDeclarationFile(
  filePath: string,
  overrides: string[] = [],
): LoadedDeclaration {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new SimulatorLoadError(
      `cannot read scenario file ${filePath}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (overrides.length === 0) {
    return {
      declaration: parseDeclaration(raw, filePath),
      path: filePath,
      raw,
      overrides: {},
    };
  }
  // Overrides mutate the parsed YAML *before* validation, so an invalid
  // tweak fails with the same schema errors an invalid file would.
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    const detail = err instanceof YAMLException ? err.message : String(err);
    throw new SimulatorLoadError(`${filePath}: invalid YAML: ${detail}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new SimulatorLoadError(
      `${filePath}: expected a YAML mapping at the top level`,
    );
  }
  const canonical: Record<string, string> = {};
  for (const text of overrides) {
    const { path: overridePath, value } = parseOverride(text);
    applyOverride(data as Record<string, unknown>, overridePath, value, text);
    canonical[overridePath.join(".")] = JSON.stringify(value);
  }
  const sorted = Object.fromEntries(
    Object.entries(canonical).sort(([a], [b]) => a.localeCompare(b)),
  );
  const effectiveRaw =
    raw +
    "\n# --set overrides\n" +
    Object.entries(sorted)
      .map(([overridePath, value]) => `# ${overridePath}=${value}`)
      .join("\n") +
    "\n";
  const declaration = (() => {
    try {
      return declarationSchema.parse(data);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new SimulatorLoadError(
          `${filePath} (with --set overrides): invalid declaration:\n${formatIssues(err)}`,
        );
      }
      throw err;
    }
  })();
  return { declaration, path: filePath, raw: effectiveRaw, overrides: sorted };
}
