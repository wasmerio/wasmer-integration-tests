import { fail } from "jsr:@std/assert/fail";
import { TestEnv } from "../src/env.ts";
import { validateWordpressIsLive } from "../src/wordpress.ts";

/*
 * This tests autobuild deployment of wordpress via a graphql subscription.
 */
Deno.test("autobuild-wordpress", {}, async (t) => {
  const env = TestEnv.fromEnv();
  let app_url: string = "";
  await t.step("deploy via autobuild", async () => {
    const extra_data = {
      wordpress: {
        adminEmail: "something@something.com",
        adminUsername: "admin",
        adminPassword: "password123!",
        language: "en_US",
        siteName: "My Wordpress Site",
      },
    };
    app_url = await env.deployAppFromRepo(
      "https://github.com/wasmerio/wordpress",
      extra_data,
    ) ?? "";
    if (!app_url || app_url === "") {
      fail("Failed to deploy wordpress app via autobuild");
    }
  });

  await validateWordpressIsLive(t, app_url, env);
});

Deno.test("autobuild-wordpress: custom branch", {}, async (t) => {
  const env = TestEnv.fromEnv();
  let app_url: string = "";
  await t.step("deploy via autobuild", async () => {
    const extra_data = {
      wordpress: {
        adminEmail: "something@something.com",
        adminUsername: "admin",
        adminPassword: "password123!",
        language: "en_US",
        siteName: "My Wordpress Site",
      },
    };
    app_url = await env.deployAppFromRepo(
      "https://github.com/wasmerio/wordpress",
      extra_data,
      "main",
    ) ?? "";
    if (!app_url || app_url === "") {
      fail("Failed to deploy wordpress app via autobuild");
    }
  });

  await validateWordpressIsLive(t, app_url, env);
});

Deno.test("autobuild-wordpress: spanish", {}, async (t) => {
  const env = TestEnv.fromEnv();
  let app_url: string = "";
  await t.step("deploy via autobuild", async () => {
    const extra_data = {
      wordpress: {
        adminEmail: "something@something.com",
        adminUsername: "admin",
        adminPassword: "password123!",
        language: "es_ES",
        siteName: "Mi sitio de Wordpress",
      },
    };
    app_url = await env.deployAppFromRepo(
      "https://github.com/wasmerio/wordpress",
      extra_data,
    ) ?? "";
    if (!app_url || app_url === "") {
      fail("Failed to deploy wordpress app via autobuild");
    }
  });

  await validateWordpressIsLive(t, app_url, env);
});
