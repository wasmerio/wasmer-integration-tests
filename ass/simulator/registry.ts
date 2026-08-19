// The simulator's maintainability seam (worklog "Maintainability shape"):
// two small open unions, mirroring ASS's executor registry. A new state axis
// is additive — one Seeder (plan/apply), one TeardownKind (down), one schema
// block. Seeders run in the spec §3.1 correlation order; teardown replays in
// reverse creation order, each kind idempotent and error-accumulating.

import type { PlatformDriver } from "../fixtures/localPlatform";
import type { SimulatorDeclaration } from "./schema";
import type { TeardownEntry } from "./descriptor";
import type { Random } from "./random";

export interface SimulatorIo {
  out(line: string): void;
  err(line: string): void;
}

/** A declaration whose expansion refuses at plan time (e.g. the D-A row
 * budget). Always a usage exit (1); nothing has been written. */
export class SeedPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedPlanError";
  }
}

/** IDs read back from the backend after real resources exist (spec §3.1
 * step 3). Phase 2 fills it; Phases 3–4 correlate against it and never
 * re-derive. */
export interface CorrelationIds {
  userId?: string;
  namespace?: string;
  namespaceId?: string;
  /** Numeric registry_namespace PK — ClickHouse `app_owner_id`. */
  namespacePk?: number;
  /** Numeric auth_user PK (fabricated rows' created_by/published_by). */
  userPk?: number;
  /** The scenario user's API token; deploys and reads run as that user. */
  token?: string;
  /** Whole-history telemetry totals (set by the telemetry seeder); the
   * billing seeder sizes entitlement limits from them. */
  telemetryTotals?: {
    memoryGbh: number;
    wallCpuMillis: number;
    requests: number;
    daily: Array<{ date: string; memoryGbh: number }>;
  };
  apps: Array<{
    name: string;
    appId: string;
    /** Numeric backend PK — ClickHouse `app_id`. */
    appPk: number;
    versionId: string | null;
    /** Numeric version PK — ClickHouse `app_version_id`. */
    versionPk: number | null;
    url: string | null;
    /** False for D-D fabricated portfolio rows (never deployed). */
    real: boolean;
    /** Which fixture the app was generated from (weighted-mix support). */
    fixture?: string;
  }>;
}

export interface PlanContext {
  seed: number;
  random: Random;
}

export interface SeedContext {
  repoDir: string;
  /** Resolved test-env.sh values; already past the layer-one guard. */
  env: Record<string, string>;
  seed: number;
  random: Random;
  io: SimulatorIo;
  verbose: boolean;
  ids: CorrelationIds;
}

/** Appends a descriptor entry and flushes it to disk before returning, so
 * the descriptor covers everything that exists even after a crash. */
export type EmitEntry = (entry: TeardownEntry) => void;

export interface Seeder {
  /** Declaration block this seeder owns; skipped when absent. */
  readonly block: "account" | "apps" | "telemetry" | "billing";
  /** Pure expansion for `--plan`: no platform, no side effects. */
  plan(declaration: SimulatorDeclaration, ctx: PlanContext): string[];
  apply(
    declaration: SimulatorDeclaration,
    ctx: SeedContext,
    emit: EmitEntry,
  ): Promise<void>;
}

export interface TeardownContext {
  repoDir: string;
  /** null when the platform is gone; datastore kinds are then never
   * dispatched (volume death already satisfied them). */
  env: Record<string, string> | null;
  driver: PlatformDriver;
  io: SimulatorIo;
  verbose: boolean;
}

export interface TeardownKind {
  readonly kind: string;
  /** Idempotent; never throws — accumulated error strings keep one failed
   * entry from masking the rest (contract.ts cleanup shape). */
  down(entry: TeardownEntry, ctx: TeardownContext): Promise<string[]>;
}

const localPlatformKind: TeardownKind = {
  kind: "local-platform",
  async down(_entry, ctx) {
    // LocalPlatformDriver.down() already short-circuits when no run exists.
    const error = await ctx.driver.down();
    return error === null ? [] : [error];
  },
};

/** Seeders in spec §3.1 order — the returned array literal is the ordering
 * contract: account → apps → telemetry → billing. Loaded dynamically so
 * `ass list`/`try`/`run` never pay for the simulator's client dependency
 * tree; the verbs await this before seeding. */
export async function builtinSeeders(): Promise<Seeder[]> {
  const [
    { accountSeeder },
    { appsSeeder },
    { telemetrySeeder },
    { billingSeeder },
  ] = await Promise.all([
    import("./seeders/account"),
    import("./seeders/apps"),
    import("./seeders/telemetry"),
    import("./seeders/billing"),
  ]);
  return [accountSeeder, appsSeeder, telemetrySeeder, billingSeeder];
}

export async function builtinTeardownKinds(): Promise<TeardownKind[]> {
  const {
    accountKind,
    deployedAppKind,
    postgresRowsKind,
    clickhouseRowsKind,
    djstripeRowsKind,
  } = await import("./kinds");
  return [
    localPlatformKind,
    accountKind,
    deployedAppKind,
    postgresRowsKind,
    clickhouseRowsKind,
    djstripeRowsKind,
  ];
}

export function resolveTeardownKind(
  kinds: TeardownKind[],
  kind: string,
): TeardownKind | null {
  return kinds.find((candidate) => candidate.kind === kind) ?? null;
}
