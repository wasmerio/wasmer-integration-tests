import { sleep } from "./util";

const MAX_RETRIES = 30;
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

export async function validateWordpressIsLive(appUrl: string): Promise<void> {
  if (appUrl === "") {
    throw new Error("Expected appUrl to be set");
  }

  let lastAttempt: ValidationAttempt = { body: "" };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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

    if (attempt < MAX_RETRIES) {
      if (process.env.VERBOSE === "true") {
        console.debug(
          `WordPress validation attempt ${attempt}/${MAX_RETRIES} failed: ${validationFailureReason(lastAttempt)}`,
        );
      }
      await sleep(RETRY_DELAY_MS);
    }
  }

  throw new Error(
    [
      `Failed to validate deployed WordPress app at ${appUrl} after ${MAX_RETRIES} attempts: ${validationFailureReason(lastAttempt)}.`,
      lastAttempt.body
        ? `Response body excerpt:\n${bodyExcerpt(lastAttempt.body)}`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
