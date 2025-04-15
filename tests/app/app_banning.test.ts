import { assert } from "jsr:@std/assert";

import { buildStaticSiteApp, sleep, TestEnv } from "../../src/index.ts";

// Test that blackholed apps do not serve DNS records anymore.
Deno.test("app-ban-blackholed", async () => {
  const spec = buildStaticSiteApp();

  // Enable debug mode to allow for instance ID and instance purging.
  spec.appYaml.debug = true;

  const env = TestEnv.fromEnv();
  const info = await env.deployApp(spec);
  const domain = (new URL(info.url)).host;

  const _res = await env.fetchApp(info, "/");
  const ips = await env.resolveAppDns(info);
  assert(ips.a.length > 0, "No IPs found for app URL");

  // Now blackhole-ban the app.
  console.log("Banning app through backend API...");
  await env.backend.banApp({ appId: info.id, reason: "test", blackhole: true });

  // Wait for the app to be blackholed.

  console.log("waiting for Edge server to stop serving DNS records...");

  const start = Date.now();

  const timeoutSecs = 60;
  while (true) {
    const newIps = await env.resolveAppDns(info);
    if (newIps.a.length == 0 && newIps.aaaa.length == 0) {
      break;
    }
    console.log("dns server is still returning records for domain", {
      domain,
      newIps,
    });

    const elapsed = Date.now() - start;
    if (elapsed > timeoutSecs * 1000) {
      throw new Error(
        `Timed out waiting for app ${domain} to be blackholed - still serving DNS records after ${timeoutSecs} seconds`,
      );
    }
    await sleep(1000);
  }
});
