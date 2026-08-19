// The engine-facing API (section 6). One adapter per kind; nothing else in
// the engine knows a store exists. An adapter never sees a declaration, a
// seed or a scenario name - only resources, operations and a scope.

import type {
  Digest,
  Lane,
  OpResult,
  Operation,
  Resource,
  ResourceKind,
} from "./model";
import type { EngineContext } from "./engine/context";

export interface Scope {
  /** The managed workspace; ownership is scoped to it (section 8.1). */
  namespace: string;
  /** The declared account username - identity is name-scoped, not
   * marker-scoped, because it is shared with the human at the keyboard. */
  username: string;
  scenario: string;
  /** Whether identity survives teardown - v1's superuser lens. */
  pinned: boolean;
  anchorMs: number;
  /** Telemetry domain, [anchor - history, anchor). */
  fromSec: number;
  toSec: number;
  /** Level-2 drill set: `${app}/${epochDay}` groups whose digest differs.
   * Undefined means "observe everything" (no digest level available). */
  drill?: Set<string>;
}

export interface ResourceAdapter<S = unknown> {
  readonly kind: ResourceKind;
  readonly lane: Lane;
  readonly granularity: "resource" | "group" | "bucket";
  /** Planning-only kinds (digest parents) are never applied. */
  readonly virtual?: boolean;

  observe(scope: Scope, ctx: EngineContext): Promise<Resource<S>[]>;

  /** Per-kind diff. The default below serves resource/group kinds; bucket
   * kinds override with the numeric, one-sided semantics of section 7.3. */
  diff(
    desired: Resource<S> | null,
    observed: Resource<S> | null,
    ctx: DiffContext,
  ): Operation[];

  apply(ops: Operation<S>[], ctx: EngineContext): Promise<OpResult[]>;

  /** Level-1 observation (section 9.2). */
  observeDigests?(scope: Scope, ctx: EngineContext): Promise<Digest[]>;
}

export interface DiffContext {
  /** `--exact`: telemetry becomes two-sided. CI's mode, not a developer's. */
  exact: boolean;
  /** Desired digest fingerprints recorded by the previous reconcile, and
   * this reconcile's. Their difference is the *declared intent* test of
   * section 7.3; neither is ever evidence of state. */
  previousDigests: Map<string, string>;
  desiredDigests: Map<string, string>;
  /** Per-app epoch second from which the *previous* reconcile wrote raw
   * rows. P1 fixes one mode per bucket at a point in time; the window
   * moves, so this is how a mode change becomes a `demote`/`promote` pair
   * (P3) instead of a silent overwrite. Empty on a first reconcile. */
  previousRawFrom: Map<string, number>;
  /** Surplus sink: reported, never acted on unless `exact`. */
  reportSurplus(entry: {
    id: Resource["id"];
    desired: number;
    observed: number;
  }): void;
}

/** The default diff for definition-shaped kinds: fingerprint equality,
 * create/update/delete. `retain` suppresses the delete (v1's pinned
 * superuser, spelled as policy). */
export function defaultDiff<S>(
  lane: Lane,
  desired: Resource<S> | null,
  observed: Resource<S> | null,
): Operation[] {
  if (desired !== null && observed === null) {
    return [
      {
        type: "create",
        id: desired.id,
        kind: desired.kind,
        lane,
        desired,
        observed: null,
      },
    ];
  }
  if (desired === null && observed !== null) {
    if (observed.policy.prune === "retain") {
      return [];
    }
    return [
      {
        type: "delete",
        id: observed.id,
        kind: observed.kind,
        lane,
        desired: null,
        observed,
      },
    ];
  }
  if (
    desired !== null &&
    observed !== null &&
    desired.fingerprint !== observed.fingerprint
  ) {
    return [
      {
        type: "update",
        id: desired.id,
        kind: desired.kind,
        lane,
        desired,
        observed,
      },
    ];
  }
  return [];
}
