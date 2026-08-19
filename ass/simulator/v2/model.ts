// The v2 contract (business-simulator-v2-reconciler §4/§5): the typed
// resource model both halves speak. The declaration half emits Resources
// and nothing else; the engine half consumes Resources and Operations and
// never sees a scenario. Everything here is pure — no I/O, no store names.

import { createHash } from "node:crypto";

export type ResourceKind =
  | "user"
  | "namespace"
  | "app"
  | "app-version"
  | "domain"
  | "volume"
  | "database"
  | "cronjob"
  | "plan-version"
  | "subscription"
  | "invoice"
  | "request-day"
  | "request-bucket"
  | "request"
  | "workload-day"
  | "workload-bucket"
  | "log-line"
  | "volume-usage"
  | "database-usage"
  | "usage-period";

/** Stream order (§4: the contract is ordered by `(kind, id)`) and, for the
 * scheduler, the coarse creation order: identity before the things that
 * hang off it, definitions before their usage series. */
export const KIND_ORDER: readonly ResourceKind[] = [
  "user",
  "namespace",
  "app",
  "app-version",
  "domain",
  "volume",
  "database",
  "cronjob",
  "plan-version",
  "subscription",
  "invoice",
  "request-day",
  "request-bucket",
  "request",
  "workload-day",
  "workload-bucket",
  "log-line",
  "volume-usage",
  "database-usage",
  "usage-period",
];

const KIND_INDEX = new Map<ResourceKind, number>(
  KIND_ORDER.map((kind, index) => [kind, index]),
);

export function kindIndex(kind: ResourceKind): number {
  const index = KIND_INDEX.get(kind);
  if (index === undefined) {
    throw new Error(`unknown resource kind "${kind}"`);
  }
  return index;
}

export interface ResourceId {
  kind: ResourceKind;
  /** Canonical, ordered natural-key segments — stable across reseeds and
   * independent of any store (§5.1). */
  segments: readonly string[];
}

export function id(kind: ResourceKind, ...segments: string[]): ResourceId {
  return { kind, segments };
}

export function key(resourceId: ResourceId): string {
  return `${resourceId.kind}:${resourceId.segments.join("/")}`;
}

/** Total order over ids: kind first (stream order), then segments. Segment
 * comparison is lexicographic *per segment* so numeric-looking segments are
 * compared as fixed-width strings by their producers (epoch hours are
 * zero-padded by the expanders). */
export function compareIds(a: ResourceId, b: ResourceId): number {
  const byKind = kindIndex(a.kind) - kindIndex(b.kind);
  if (byKind !== 0) {
    return byKind;
  }
  const length = Math.max(a.segments.length, b.segments.length);
  for (let index = 0; index < length; index++) {
    const left = a.segments[index] ?? "";
    const right = b.segments[index] ?? "";
    if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

export type PrecisionMode = "aggregate" | "raw" | "literal";

export interface ResourcePolicy {
  /** `retain` is v1's pinned superuser: teardown keeps the row. */
  prune: "delete" | "retain";
  /** Telemetry kinds only (§7). */
  precision?: PrecisionMode;
  /** §13: a direct write for a `deployed` resource is a defect. */
  realism?: "deployed" | "fabricated";
}

export interface Resource<S = unknown> {
  id: ResourceId;
  kind: ResourceKind;
  spec: S;
  /** Canonical hash of the diff-relevant spec — the only thing the planner
   * compares. */
  fingerprint: string;
  deps: ResourceId[];
  policy: ResourcePolicy;
}

/** Canonical JSON: object keys sorted, so a fingerprint depends on content
 * and never on construction order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function fingerprint(spec: unknown): string {
  return createHash("sha1")
    .update(canonicalJson(spec))
    .digest("hex")
    .slice(0, 16);
}

export function resource<S>(input: {
  id: ResourceId;
  spec: S;
  deps?: ResourceId[];
  policy?: Partial<ResourcePolicy>;
  /** Override the fingerprint input when the spec carries fields the diff
   * must ignore (display-only detail, discovered ids). */
  fingerprintOf?: unknown;
}): Resource<S> {
  return {
    id: input.id,
    kind: input.id.kind,
    spec: input.spec,
    fingerprint: fingerprint(input.fingerprintOf ?? input.spec),
    deps: input.deps ?? [],
    policy: { prune: "delete", ...input.policy },
  };
}

export type OperationType =
  | "create"
  | "update"
  | "patch"
  | "replace"
  | "delete"
  | "demote"
  | "promote";

export type Lane = "sdk" | "clickhouse" | "postgres";

export interface Operation<S = unknown> {
  type: OperationType;
  id: ResourceId;
  kind: ResourceKind;
  lane: Lane;
  desired: Resource<S> | null;
  observed: Resource<S> | null;
  /** Adapter-defined payload: a bucket patch's delta, a mode transition's
   * from/to, the table a delete coalesces into. */
  detail?: Record<string, unknown>;
}

export interface OpResult {
  id: ResourceId;
  ok: boolean;
  error?: string;
  /** Statements/rows actually issued — plan output and the ledger record
   * these so a timing anomaly is attributable afterwards. */
  stats?: Record<string, number>;
}

/** §9.2 level-1: one digest per coarse group, computable by both halves. */
export interface Digest {
  id: ResourceId;
  fingerprint: string;
  members: number;
}

/** Reported, never acted on (§7.3/P4) unless `--exact`. */
export interface Surplus {
  id: ResourceId;
  kind: ResourceKind;
  desired: number;
  observed: number;
}

export function opCost(operation: Operation): number {
  return operation.type === "delete" ? 2 : 1;
}
