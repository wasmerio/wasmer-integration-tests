// Injection seams for the lifecycle verbs, mirroring RunnerDeps: tests fake
// the platform driver, the liveness probe, the clock, and the store
// adapters without touching docker or the network.

import type { PlatformDriver } from "../fixtures/localPlatform";
import type { FetchLike } from "./platform";
import type { ResourceAdapter } from "./adapter";

export interface SimulatorDeps {
  driver?: PlatformDriver;
  fetchImpl?: FetchLike;
  /** The store seam: fake adapters replace the built-in registry, so a
   * full (non-plan) `up`/`down` reconcile is unit-drivable with no live
   * GraphQL/Postgres/ClickHouse behind it. */
  adapters?: ResourceAdapter[];
  now?: () => number;
}
