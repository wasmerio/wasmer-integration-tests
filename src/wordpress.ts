import { isVerboseEnabled, type TestEnv } from "./env";
import { sleep } from "./util";

const DEFAULT_MAX_RETRIES = 30;
const LOCAL_PLATFORM_MAX_RETRIES = 120;
const RETRY_DELAY_MS = 2000;
const FAILURE_BODY_EXCERPT_LENGTH = 1000;
// A freshly-deployed, not-yet-installed WordPress redirects "/" to the install
// wizard. We need to follow that hop to observe the rendered page.
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type ValidationAttempt = {
  status?: number;
  ok?: boolean;
  body: string;
  error?: unknown;
};

function bodyExcerpt(body: string): string {
  if (body.length <= FAILURE_BODY_EXCERPT_LENGTH) {
    return body;
  }

  return `${body.slice(0, FAILURE_BODY_EXCERPT_LENGTH)}\n... and ${body.length - FAILURE_BODY_EXCERPT_LENGTH} more characters (rerun with VERBOSE=true to inspect the full response)`;
}

function validationFailureReason(attempt: ValidationAttempt): string {
  if (attempt.error) {
    return `request failed: ${attempt.error}`;
  }

  if (!attempt.ok) {
    return `response status was ${attempt.status ?? "unknown"}`;
  }

  if (!attempt.body.includes("<html")) {
    return "response did not contain '<html'";
  }

  return "response did not contain 'WordPress'";
}

function maxRetries(): number {
  const raw = process.env.WASMER_TEST_WORDPRESS_MAX_RETRIES;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return process.env.LOCAL_PLATFORM_RELAX_EDGE_VERSION_HEADER
    ? LOCAL_PLATFORM_MAX_RETRIES
    : DEFAULT_MAX_RETRIES;
}

/**
 * Fetch the app, following redirects manually through the TestEnv Edge helper.
 *
 * We must go through `env.fetchApp` (not a raw `fetch`) so that the request is
 * routed to the configured Edge target and the `Host` header / local redirect
 * `Location` rewriting are applied. A raw `fetch` only works when the app URL
 * is reachable on standard ports via real DNS (e.g. the dev backend); against
 * the disposable local platform, where Edge listens on isolated host ports, the
 * canonical `*.localhost` URL is not directly reachable and the request never
 * lands on Edge.
 */
async function fetchAppFollowingRedirects(
  env: TestEnv,
  appUrl: string,
): Promise<Response> {
  let target = appUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // No explicit `redirect` mode: against the dev backend this goes through a
    // real `fetch` that auto-follows redirects to the final page, while the
    // local Edge path (fetchWithHostOverride) returns each redirect response
    // with a readable, port-normalized `Location` that we follow below.
    const response = await env.fetchAppUrlThroughEdge(target, {
      method: "GET",
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }
    // Resolve relative redirect targets against the URL we just requested.
    target = new URL(location, target).toString();
  }

  throw new Error(
    `Exceeded ${MAX_REDIRECTS} redirects while fetching WordPress app ${appUrl}`,
  );
}

export async function validateWordpressIsLive(
  env: TestEnv,
  appUrl: string,
): Promise<void> {
  if (appUrl === "") {
    throw new Error("Expected appUrl to be set");
  }

  let lastAttempt: ValidationAttempt = { body: "" };
  const retries = maxRetries();

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetchAppFollowingRedirects(env, appUrl);
      const body = await response.text();
      lastAttempt = {
        status: response.status,
        ok: response.ok,
        body,
      };

      if (response.ok && body.includes("<html") && body.includes("WordPress")) {
        return;
      }
    } catch (error) {
      lastAttempt = { body: "", error };
    }

    if (attempt < retries) {
      if (isVerboseEnabled()) {
        console.debug(
          `WordPress validation attempt ${attempt}/${retries} failed: ${validationFailureReason(lastAttempt)}`,
        );
      }
      await sleep(RETRY_DELAY_MS);
    }
  }

  throw new Error(
    [
      `Failed to validate deployed WordPress app at ${appUrl} after ${retries} attempts: ${validationFailureReason(lastAttempt)}.`,
      lastAttempt.body
        ? `Response body excerpt:\n${bodyExcerpt(lastAttempt.body)}`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
