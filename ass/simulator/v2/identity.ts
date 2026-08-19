// Section 5.2 - bindings. Natural keys are what declarations and the
// planner speak; store-native identifiers (`da_...`, integer PKs, volume
// UUIDs) are *discovered* during OBSERVE and consulted during APPLY.
// Cached in the ledger as a fast path, never trusted as truth.

import { key, type ResourceId, type ResourceKind } from "./model";

export type NativeIds = Readonly<Record<string, string | number>>;

export interface Binding {
  id: ResourceId;
  native: NativeIds;
}

export class IdentityMap {
  private readonly forward = new Map<string, Record<string, string | number>>();
  private readonly reverse = new Map<string, ResourceId>();

  bind(resourceId: ResourceId, native: NativeIds): void {
    const existing = this.forward.get(key(resourceId)) ?? {};
    const merged = { ...existing, ...native };
    this.forward.set(key(resourceId), merged);
    for (const [field, value] of Object.entries(native)) {
      this.reverse.set(`${resourceId.kind} ${field} ${value}`, resourceId);
    }
  }

  native(resourceId: ResourceId): NativeIds | undefined {
    return this.forward.get(key(resourceId));
  }

  /** Throws rather than writing with a guessed identifier: a missing
   * binding is an OBSERVE gap, and inventing one would write to the wrong
   * row. */
  require(resourceId: ResourceId, field: string): string | number {
    const native = this.forward.get(key(resourceId));
    const value = native?.[field];
    if (value === undefined) {
      throw new Error(
        `no ${field} binding for ${key(resourceId)} - OBSERVE did not ` +
          "discover it and the engine refuses to guess a store identifier",
      );
    }
    return value;
  }

  requireNumber(resourceId: ResourceId, field: string): number {
    const value = this.require(resourceId, field);
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error(
        `${field} binding for ${key(resourceId)} is not numeric: ${value}`,
      );
    }
    return numeric;
  }

  requireString(resourceId: ResourceId, field: string): string {
    return String(this.require(resourceId, field));
  }

  byNative(
    kind: ResourceKind,
    field: string,
    value: string | number,
  ): ResourceId | undefined {
    return this.reverse.get(`${kind} ${field} ${value}`);
  }

  has(resourceId: ResourceId): boolean {
    return this.forward.has(key(resourceId));
  }

  toJSON(): Array<{ key: string; native: Record<string, string | number> }> {
    return [...this.forward.entries()]
      .map(([entryKey, native]) => ({ key: entryKey, native }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  static fromJSON(
    entries: Array<{ key: string; native: Record<string, string | number> }>,
  ): IdentityMap {
    const map = new IdentityMap();
    for (const entry of entries) {
      const separator = entry.key.indexOf(":");
      if (separator <= 0) {
        continue;
      }
      const kind = entry.key.slice(0, separator) as ResourceKind;
      const segments = entry.key.slice(separator + 1).split("/");
      map.bind({ kind, segments }, entry.native);
    }
    return map;
  }
}
