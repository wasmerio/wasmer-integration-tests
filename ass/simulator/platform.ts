// Platform resolution for the lifecycle verbs. Liveness is probed against
// the backend endpoint, never inferred from the `current` symlink: down.py
// leaves the symlink pointing at a torn-down run, so symlink presence is
// exactly the trap this module exists to avoid.

import type { PlatformDriver, DriverIo } from "../fixtures/localPlatform";

export type FetchLike = (
  url: string,
  init?: { method?: string; signal?: AbortSignal },
) => Promise<{ status: number }>;

/** Any HTTP answer means a server is listening; only a transport error
 * (nothing listening, DNS, reset) reads as dead. */
export async function probeBackend(
  registryUrl: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 3000,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(registryUrl, { method: "GET", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface ResolvedPlatform {
  /** Parsed test-env.sh values. */
  env: Record<string, string>;
  /** True when this call booted the stack (descriptor `ownsPlatform`). */
  booted: boolean;
}

/** Reuse a live platform, else boot one. Unlike `resolveLocal`, never tear
 * down a pre-existing run: reseeding is seconds, boots are minutes (spec §5),
 * and `up` declares no pins that would demand a fresh boot. */
export async function resolvePlatform(
  driver: PlatformDriver,
  io: DriverIo,
  fetchImpl: FetchLike = fetch,
): Promise<ResolvedPlatform> {
  const live = await platformIsLive(driver, fetchImpl);
  if (live !== null) {
    io.info("reusing the running local platform");
    return { env: live, booted: false };
  }
  io.info("no live local platform — booting one (this takes minutes)");
  await driver.up();
  return { env: driver.readTestEnv(), booted: true };
}

/** The platform's env when it is actually serving, else null. */
export async function platformIsLive(
  driver: PlatformDriver,
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, string> | null> {
  if (driver.currentRunDir() === null) {
    return null;
  }
  let env: Record<string, string>;
  try {
    env = driver.readTestEnv();
  } catch {
    return null;
  }
  const registry = env["WASMER_REGISTRY"];
  if (registry === undefined || registry === "") {
    return null;
  }
  return (await probeBackend(registry, fetchImpl)) ? env : null;
}
