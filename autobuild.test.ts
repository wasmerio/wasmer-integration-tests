import { fail } from "jsr:@std/assert/fail";
import { TestEnv } from "./src/env.ts";

/*
 * This tests autobuild deployment of wordpress via a graphql subscription.
 */
Deno.test("autobuild-wordpress", {}, async (t) => {
  const env = TestEnv.fromEnv();
  await t.step("deploy via autobuild", async () => {
    const extra_data = {
      wordpress: {
        adminEmail: "something@something.com",
        adminUsername: "admin",
        adminPassword: "password123!",
        language: "en_US",
        siteName: "My Wordpress Site"
      }
    };
    const url = await env.deployAppFromRepo("https://github.com/wasmerio/wordpress", extra_data);
    if (!url) {
      fail("Failed to deploy wordpress app via autobuild");
    }
    // check if the url is live
    let response = await env.httpClient.fetch(url, { method: "GET" });
    if (response.status !== 200) {
      fail(`Failed to fetch deployed wordpress app via autobuild: ${await response.text()}`);
    }
  });
});
