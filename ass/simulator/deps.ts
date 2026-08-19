// Injection seams for the lifecycle verbs, mirroring RunnerDeps: tests fake
// the platform driver, the liveness probe, the clock, and the registries
// without touching docker or the network.

import type { PlatformDriver } from "../fixtures/localPlatform";
import type { FetchLike } from "./platform";
import type { Seeder, TeardownKind } from "./registry";

export interface SimulatorDeps {
  driver?: PlatformDriver;
  fetchImpl?: FetchLike;
  seeders?: Seeder[];
  teardownKinds?: TeardownKind[];
  now?: () => number;
}
