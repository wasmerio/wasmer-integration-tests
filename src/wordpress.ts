import { sleep } from "./util";

const DEFAULT_MAX_RETRIES = 30;
const LOCAL_PLATFORM_MAX_RETRIES = 120;
const RETRY_DELAY_MS = 2000;
const FAILURE_BODY_EXCERPT_LENGTH = 1000;

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

export async function validateWordpressIsLive(appUrl: string): Promise<void> {
  if (appUrl === "") {
    throw new Error("Expected appUrl to be set");
  }

  let lastAttempt: ValidationAttempt = { body: "" };
  const retries = maxRetries();

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(appUrl, { method: "GET" });
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
      if (process.env.VERBOSE === "true") {
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
