import { fail } from "jsr:@std/assert/fail";
import { TestEnv } from "./index.ts";

export async function validateWordpressIsLive(
  t: Deno.TestContext,
  app_url: string,
  env: TestEnv,
) {
  if (app_url === "") {
    fail(`Expected app_url to be set`);
  }

  await t.step("validate properly setup", async () => {
    // retry with backoff until the body (stripped) is not empty
    const MAX_RETRIES = 10;
    const RETRY_DELAY_MS = 2000;

    let body = "";
    let got: Response | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        got = await env.httpClient.fetch(app_url, { method: "GET" });
        body = await got.text();

        if (body.trim() !== "") {
          break;
        }
      } catch (_err) {
        // Could log or collect errors if needed
      }

      const backoff = RETRY_DELAY_MS * Math.pow(1.5, attempt);
      const jitter = Math.random() * 300;
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
    }

    if (!got || !got.ok) {
      fail(
        `Failed to fetch deployed WordPress app. Response not OK or missing. Body:\n${body}`,
      );
    }
    if (!got.ok) {
      fail(
        `Failed to fetch deployed wordpress app. Response not OK. Body: ${body}
\n\nFull response:${got}`,
      );
    }
    if (!body.includes("<html")) {
      fail(`Expected fetched body to include a html tag, received:\n${body}
\n\nFull response:${got}`);
    }

    if (!body.includes("WordPress")) {
      fail(
        `Expected fetched body to include substring 'WordPress', received:\n${body}
\n\nFull response:${got}`,
      );
    }
  });
}
