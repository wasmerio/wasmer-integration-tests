// Per-kind spec types: the vocabulary both halves share. A spec says what
// a resource *is*, never where it lives - the adapter owns that.

import { fingerprint } from "./model";

export interface UserSpec {
  username: string;
  email: string;
  password: string;
}

export interface NamespaceSpec {
  name: string;
  owner: string;
}

export interface AppSpec {
  namespace: string;
  name: string;
  fixture: string;
  /** Days before the anchor the app was created; fabricated apps only. */
  ageDays: number;
}

export interface AppVersionSpec {
  namespace: string;
  app: string;
  version: number;
  active: boolean;
  failed: boolean;
  ageDays: number;
}

export interface DomainSpec {
  namespace: string;
  app: string;
  fqdn: string;
  kind: "deployment" | "custom";
}

export interface VolumeSpec {
  namespace: string;
  app: string;
  mountPath: string;
  maxSizeBytes: number;
}

export interface DatabaseSpec {
  namespace: string;
  app: string;
  name: string;
}

export interface CronjobSpec {
  namespace: string;
  app: string;
  name: string;
  schedule: string;
  kind: "fetch" | "execute";
  enabled: boolean;
  path: string;
  method: string;
}

export type BucketMode = "aggregate" | "raw";

export interface RequestBucketSpec {
  namespace: string;
  app: string;
  epochHour: number;
  mode: BucketMode;
  /** Desired floor for this hour, literals included (P1). */
  requests: number;
  http5xx: number;
  errPermille: number;
  /** Fingerprint-relevant declaration inputs: an edit to any of them is a
   * declared change, which the ledger turns into a `replace` (section 7.3). */
  latency: { p50: string; p95: string; p99: string };
  literals: number;
  /** Row content is generated server-side from a seeded hash, so the seed
   * is part of what the bucket *is*: changing it rewrites the world. */
  seed: number;
}

export interface RequestSpec {
  namespace: string;
  app: string;
  requestId: string;
  atMs: number;
  method: string;
  path: string;
  status: number;
  durationUs: number;
  ip: string;
  requestBytes: number;
  responseBytes: number;
}

export interface WorkloadBucketSpec {
  namespace: string;
  app: string;
  epochHour: number;
  cpuMillis: number;
  memoryTimeKbs: number;
  ingressKb: number;
  egressKb: number;
}

export interface LogLineSpec {
  namespace: string;
  app: string;
  tsNanos: string;
  stream: "stdout" | "stderr" | "runtime";
  message: string;
}

export interface VolumeUsageSpec {
  namespace: string;
  app: string;
  mountPath: string;
  epochHour: number;
  sizeBytes: number;
}

export interface DatabaseUsageSpec {
  namespace: string;
  app: string;
  database: string;
  epochHour: number;
  usageBytes: number;
}

export interface UsagePeriodSpec {
  namespace: string;
  resolution: string;
  startSec: number;
  endSec: number;
  requests: number;
  memoryGbh: number;
  cpuHours: number;
  ingressBytes: number;
  egressBytes: number;
  appCount: number;
  domainCount: number;
  volumeBytes: number;
  dbBytes: number;
}

/** Usage figures are floats on both sides; the fingerprint rounds them the
 * same way in the declaration half and in the adapter, so a converged world
 * does not churn on the last bit of a double. */
export function usagePeriodFingerprint(spec: UsagePeriodSpec): string {
  const micro = (value: number): number => Math.round(value * 1e6);
  return fingerprint({
    startSec: spec.startSec,
    endSec: spec.endSec,
    resolution: spec.resolution,
    requests: spec.requests,
    memoryGbh: micro(spec.memoryGbh),
    cpuHours: micro(spec.cpuHours),
    ingressBytes: Math.round(spec.ingressBytes),
    egressBytes: Math.round(spec.egressBytes),
    appCount: spec.appCount,
    domainCount: spec.domainCount,
    volumeBytes: spec.volumeBytes,
    dbBytes: spec.dbBytes,
  });
}

export interface PlanVersionSpec {
  slug: string;
  version: number;
  name: string;
  limits: Record<string, number>;
}

export interface SubscriptionSpec {
  namespace: string;
  plan: string;
  state: "active" | "past_due" | "canceled" | "trialing";
  periodStartSec: number;
  periodEndSec: number;
  computeConsumed: number;
}

export interface InvoiceSpec {
  namespace: string;
  number: string;
  amountCents: number;
  status: "paid" | "open" | "uncollectible";
  createdSec: number;
}

/** Digest parents (section 9.2): the resource carries the day's terms so
 * both halves can render the same fingerprint. */
export interface DayDigestSpec {
  namespace: string;
  app: string;
  epochDay: number;
  members: number;
  sums: Record<string, number>;
  weighted: number;
}
