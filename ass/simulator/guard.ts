// The local-only guard (business-simulator-v1 §6, worklog D-K): fabricated
// telemetry or billing data on a real environment would constitute fraud,
// so the simulator is local-only *by construction*. This module is both
// guard layers: `assertLocalOnly` is the verb-entry check on the resolved
// test-env endpoints, and `guardedUrl` is the connection-time re-assertion
// every datastore client calls immediately before connecting. There is
// deliberately no override — no flag, env var, or scenario key reaches
// either path, and a trip is a hard refusal, never a warning.

export class GuardRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardRefusalError";
  }
}

/** The resolved endpoints every write path flows through. All three must be
 * loopback before `up`/`down` touches anything. */
export const GUARDED_ENV_VARS = [
  "WASMER_REGISTRY",
  "LOCAL_PLATFORM_POSTGRES_URL",
  "LOCAL_PLATFORM_CLICKHOUSE_URL",
] as const;

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare === "::1") {
    return true;
  }
  // The whole 127.0.0.0/8 block is loopback by definition (RFC 5735).
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  if (v4) {
    return (
      Number(v4[1]) === 127 &&
      v4.slice(2).every((octet) => Number(octet) <= 255)
    );
  }
  return false;
}

/** Credentials never belong in a refusal message. */
export function redactUrl(raw: string): string {
  return raw.replace(/\/\/[^@/]+@/, "//<credentials>@");
}

function hostOf(name: string, raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new GuardRefusalError(
      `refusing to run: ${name}="${redactUrl(raw)}" is not a parseable ` +
        "URL, so its target cannot be verified as loopback",
    );
  }
  if (parsed.hostname === "") {
    throw new GuardRefusalError(
      `refusing to run: ${name}="${redactUrl(raw)}" has no host, so its ` +
        "target cannot be verified as loopback",
    );
  }
  return parsed.hostname;
}

/** Connection-time guard (layer two): validates one URL and hands it back.
 * Datastore clients obtain their target only through this call. */
export function guardedUrl(name: string, raw: string): string {
  const host = hostOf(name, raw);
  if (!isLoopbackHost(host)) {
    throw new GuardRefusalError(
      `refusing to run: ${name}="${redactUrl(raw)}" resolves to host ` +
        `"${host}", which is not loopback. The simulator writes fabricated ` +
        "data and only ever runs against the disposable local platform; " +
        "there is no override.",
    );
  }
  return raw;
}

/** Verb-entry guard (layer one): every guarded endpoint in the resolved env
 * must be loopback; a missing variable is a refusal, not a pass, because an
 * unverifiable target is an unverified one. */
export function assertLocalOnly(env: Record<string, string>): void {
  for (const name of GUARDED_ENV_VARS) {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      throw new GuardRefusalError(
        `refusing to run: ${name} is missing from the resolved platform ` +
          "env (test-env.sh), so the target cannot be verified as loopback",
      );
    }
    guardedUrl(name, value);
  }
}
