import { fail } from "jsr:@std/assert/fail";
import { TestEnv } from "./index.ts";
import { sleep } from "./util.ts";

export async function validateWordpressIsLive(
  t: Deno.TestContext,
  app_url: string,
  env: TestEnv,
) {
  if (app_url === "") {
    fail(`Expected app_url to be set`);
  }

  await t.step("validate properly setup", async () => {
    await sleep(10000);
    const got = await env.httpClient.fetch(app_url, { method: "GET" });
    const body = await got.text();
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
