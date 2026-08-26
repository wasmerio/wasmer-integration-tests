// The simulator declaration: what a human writes. Purely declarative - it
// names no store, no SQL and no SDK call, which is what makes the
// declaration half unit-testable with zero infrastructure.
//
// `assSchema = 1` files load unchanged: `upgradeV1` maps them onto the
// current shape, so every committed scenario reconciles without an edit.

import { readFileSync } from "node:fs";
import {
  assertTomlExtension,
  parseToml,
  parseTomlScalar,
  TomlParseError,
} from "../scenario/toml";
import { z, ZodError } from "zod";
import { FIXTURE_NAMES } from "./fixtures";

export const SUPPORTED_SCHEMA = 2;

export class SimulatorLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulatorLoadError";
  }
}

export function formatIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  ${path}: ${issue.message}`;
    })
    .join("\n");
}

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const SIGNED_DURATION_RE = /^(-?\d+)(ms|s|m|h|d)$/;
const OFFSET_RE = /^-?(\d+(ms|s|m|h|d))+$/;
const SIZE_RE = /^(\d+)(B|K|Ki|M|Mi|G|Gi)$/;

const duration = z
  .string()
  .regex(DURATION_RE, "expected a duration like 90d, 2h, 30m or 45ms");
const signedDuration = z
  .string()
  .regex(
    SIGNED_DURATION_RE,
    "expected a (possibly negative) duration like -3d or 2h",
  );
/** Compound, sub-second-capable offsets: `-2h15m30s` (section 7.1). */
const offset = z
  .string()
  .regex(OFFSET_RE, "expected an offset like -2h15m30s or -14d");
const size = z.string().regex(SIZE_RE, "expected a size like 128Mi or 1G");

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

const accountSchema = z.strictObject({
  username: z.string().min(1),
  password: z.string().min(1),
  namespace: z.string().min(1),
  /** The superuser lens; the engine spells it `policy.prune: "retain"`. */
  pinned: z.boolean().default(true),
});

const fixtureName = z.enum(FIXTURE_NAMES);
const fixtureMix = z.union([
  fixtureName,
  z
    .record(fixtureName, z.number().positive())
    .refine((mix) => Object.keys(mix).length > 0, {
      message: "fixture mix must name at least one fixture",
    }),
]);

const usageSeries = z.strictObject({
  mean: size,
  /** Fractional growth per day across the history window. */
  growth: z.number().min(-1).max(10).default(0),
  /** Sampling resolution of the written series. */
  every: duration.default("1h"),
});

const volumesSchema = z.strictObject({
  /** How many apps (in portfolio order) carry volumes. */
  apps: z.number().int().nonnegative(),
  perApp: z.number().int().positive().default(1),
  mountPath: z.string().min(1).default("/data"),
  maxSize: size.default("10Gi"),
  usage: usageSeries.optional(),
});

const databasesSchema = z.strictObject({
  apps: z.number().int().nonnegative(),
  /** Measured on the live backend: `deploy_appdatabase` has a unique index
   * on `app_id` where `deleted_at IS NULL`, so an app holds at most one
   * database. Declaring more is refused here rather than failing on an
   * index violation halfway through an apply. */
  perApp: z.literal(1).default(1),
  name: z.string().min(1).default("db_main"),
  usage: usageSeries.optional(),
});

const cronjobsSchema = z.strictObject({
  apps: z.number().int().nonnegative(),
  perApp: z.number().int().positive().default(1),
  name: z.string().min(1).default("nightly"),
  schedule: z.string().min(1).default("0 2 * * *"),
  kind: z.enum(["fetch", "execute"]).default("fetch"),
  path: z.string().default("/cron"),
  method: z.string().default("GET"),
  enabled: z.boolean().default(true),
});

const appsSchema = z.strictObject({
  count: z.number().int().positive(),
  /** Section 13: how many apps are really deployed through the API; the
   * rest are fabricated rows. `policy.realism` carries it per resource. */
  real: z.number().int().nonnegative().optional(),
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
  volumes: volumesSchema.optional(),
  databases: databasesSchema.optional(),
  cronjobs: cronjobsSchema.optional(),
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

const literalRequestSchema = z.strictObject({
  app: z.string().min(1),
  at: offset,
  method: z.string().default("GET"),
  path: z.string().default("/"),
  status: z.number().int().min(100).max(599).default(200),
  durationMs: z.number().nonnegative().optional(),
  durationUs: z.number().int().nonnegative().optional(),
  ip: z.string().default("10.0.0.1"),
  responseBytes: z.number().int().nonnegative().default(1024),
  requestBytes: z.number().int().nonnegative().default(0),
  count: z.number().int().positive().default(1),
});

const literalLogSchema = z.strictObject({
  app: z.string().min(1),
  at: offset,
  stream: z.enum(["stdout", "stderr", "runtime"]).default("stdout"),
  message: z.string().min(1),
});

const precisionSchema = z.strictObject({
  default: z.enum(["aggregate", "raw"]).default("aggregate"),
  /** Window back from the anchor that gets per-request rows. */
  raw: duration.default("48h"),
  /** Per-app widening, e.g. `{ checkout: { raw: 14d } }`. */
  apps: z.record(z.string(), z.strictObject({ raw: duration })).default({}),
});

const telemetrySchema = z.strictObject({
  history: duration,
  precision: precisionSchema.default({
    default: "aggregate",
    raw: "48h",
    apps: {},
  }),
  rps: z.strictObject({
    base: z.number().positive(),
    spikes: z.array(spikeSchema).default([]),
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
  requests: z.array(literalRequestSchema).default([]),
  logs: z.array(literalLogSchema).default([]),
  rowBudget: z.number().int().positive().optional(),
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
  assSchema: z.literal(SUPPORTED_SCHEMA),
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

export type Declaration = z.infer<typeof declarationSchema>;
export type AppsBlock = NonNullable<Declaration["apps"]>;
export type TelemetryBlock = NonNullable<Declaration["telemetry"]>;
export type BillingBlock = NonNullable<Declaration["billing"]>;
export type AccountBlock = Declaration["account"];
export type LiteralRequest = z.infer<typeof literalRequestSchema>;
export type LiteralLog = z.infer<typeof literalLogSchema>;
export type UsageSeries = z.infer<typeof usageSeries>;

/** Compound offsets (`-2h15m30s`) and plain ones; milliseconds, signed. */
export function parseOffsetMs(text: string): number {
  if (!OFFSET_RE.test(text)) {
    throw new SimulatorLoadError(
      `not an offset: "${text}" (expected e.g. -2h15m30s)`,
    );
  }
  const negative = text.startsWith("-");
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  let total = 0;
  for (const match of text.matchAll(/(\d+)(ms|s|m|h|d)/g)) {
    total += Number(match[1]) * units[match[2]];
  }
  return negative ? -total : total;
}

/** assSchema 1 -> 2. The only shape change is precision: the old
 * `rawWindow` becomes `precision.raw`; everything else is a superset. */
export function upgradeV1(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const upgraded: Record<string, unknown> = {
    ...raw,
    assSchema: SUPPORTED_SCHEMA,
  };
  const telemetry = raw["telemetry"];
  if (
    telemetry !== undefined &&
    telemetry !== null &&
    typeof telemetry === "object"
  ) {
    const block = { ...(telemetry as Record<string, unknown>) };
    const rawWindow = block["rawWindow"];
    delete block["rawWindow"];
    if (block["precision"] === undefined) {
      block["precision"] = {
        default: "aggregate",
        raw: typeof rawWindow === "string" ? rawWindow : "48h",
        apps: {},
      };
    }
    upgraded["telemetry"] = block;
  }
  return upgraded;
}

export function parseDeclaration(raw: string, sourcePath: string): Declaration {
  let data: unknown;
  try {
    data = parseToml(raw, sourcePath);
  } catch (err) {
    const detail = err instanceof TomlParseError ? err.message : String(err);
    throw new SimulatorLoadError(detail);
  }
  return validateDeclaration(data, sourcePath);
}

export function validateDeclaration(
  data: unknown,
  sourcePath: string,
): Declaration {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new SimulatorLoadError(
      `${sourcePath}: expected a TOML table at the top level`,
    );
  }
  let record = data as Record<string, unknown>;
  if (!("assSchema" in record)) {
    throw new SimulatorLoadError(
      `${sourcePath}: no assSchema key - this is not a simulator declaration. ` +
        `Simulator files declare \`assSchema = ${SUPPORTED_SCHEMA}\` ` +
        "(`assSchema = 1` files are upgraded automatically); ASS reproduction " +
        "scenarios run with `ass try`/`ass run` instead.",
    );
  }
  if (record["assSchema"] === 1) {
    record = upgradeV1(record);
  }
  if (record["assSchema"] !== SUPPORTED_SCHEMA) {
    throw new SimulatorLoadError(
      `${sourcePath}: unsupported assSchema ${JSON.stringify(record["assSchema"])}; ` +
        `this ASS build supports assSchema = 1 and ${SUPPORTED_SCHEMA}.`,
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

export interface LoadedDeclaration {
  declaration: Declaration;
  path: string;
  /** File text plus a canonical rendering of the overrides; digested for
   * reseed detection and recorded in the ledger. */
  raw: string;
  overrides: Record<string, string>;
}

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
  const value = parseTomlScalar(text.slice(eq + 1));
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

export function loadDeclarationFile(
  filePath: string,
  overrides: string[] = [],
): LoadedDeclaration {
  try {
    assertTomlExtension(filePath, "a simulator declaration");
  } catch (err) {
    throw new SimulatorLoadError(
      err instanceof Error ? err.message : String(err),
    );
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new SimulatorLoadError(
      `cannot read scenario file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
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
  let data: unknown;
  try {
    data = parseToml(raw, filePath);
  } catch (err) {
    const detail = err instanceof TomlParseError ? err.message : String(err);
    throw new SimulatorLoadError(detail);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new SimulatorLoadError(
      `${filePath}: expected a TOML table at the top level`,
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
  return {
    declaration: validateDeclaration(
      data,
      `${filePath} (with --set overrides)`,
    ),
    path: filePath,
    raw: effectiveRaw,
    overrides: sorted,
  };
}
