import { buildStaticSiteApp, TestEnv } from "../../src/index";
import { pollUntil } from "../../src/util";

// Test that blackholed apps do not serve DNS records anymore.
test.concurrent("app-ban-blackholed", async () => {
  const spec = buildStaticSiteApp();

  // Enable debug mode to allow for instance ID and instance purging.
  spec.appYaml.debug = true;

  const env = TestEnv.fromEnv();
  const info = await env.deployApp(spec);
  const domain = new URL(info.url).host;

  const ips = await env.resolveAppDns(info);
  expect(ips.a.length).toBeGreaterThan(0);

  // Now blackhole-ban the app.
  console.log("Banning app through backend API...");
  const appId = await env.backend.banApp({
    appId: info.id,
    reason: "test",
    blackhole: true,
  });
  expect(appId).toBeTruthy();

  // Wait for the app to be blackholed.
  console.log("waiting for Edge server to stop serving DNS records...");
  await pollUntil(
    async () => {
      const newIps = await env.resolveAppDns(info);
      if (newIps.a.length === 0 && newIps.aaaa.length === 0) {
        return true;
      }
      console.log("dns server is still returning records for domain", {
        domain,
        newIps,
      });
      return false;
    },
    {
      timeoutMs: 60_000,
      intervalMs: 1000,
      description: `app ${domain} to be blackholed (no more DNS records)`,
    },
  );

  // Deferred cleanup; deletion of a banned app is best-effort.
  await env.deleteApp(info);
});
