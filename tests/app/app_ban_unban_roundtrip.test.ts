import { buildStaticSiteApp, TestEnv } from "../../src/index";
import { pollUntil } from "../../src/util";

// Regression test for BE-1695.
//
// A non-blackhole ban swaps the app's workload source to the `wasmer/disabled`
// placeholder package. The app's domain must keep routing on Edge so the
// placeholder is what visitors see; it must NOT degrade into an Edge
// `400` with `x-edge-request-outcome: unknown_domain` (router tombstoned).
// Unbanning must bring the original content back.
//
// Broken by backend 8f6b1076c (2026-07-22), which tombstones the router of
// every disabled active version in the entity-log projection.
test.concurrent("app-ban-unban-roundtrip", async () => {
  const spec = buildStaticSiteApp();
  const env = TestEnv.fromEnv();
  const info = await env.deployApp(spec);

  // Sanity: the app serves its own content before the ban.
  const before = await env.fetchApp(info, "/");
  expect(await before.text()).toContain("Hello!");

  console.log("Banning app (blackhole: false) through backend API...");
  await env.backend.banApp({
    appId: info.id,
    reason: "integration test app-ban-unban-roundtrip (BE-1695)",
    blackhole: false,
  });

  // Wait until the ban propagates to Edge: the response stops carrying the
  // app's original content.
  let bannedStatus = 0;
  let bannedOutcome: string | null = null;
  let bannedBody = "";
  await pollUntil(
    async () => {
      const response = await env.fetchAppUrlThroughEdge(`${info.url}/`);
      bannedStatus = response.status;
      bannedOutcome = response.headers.get("x-edge-request-outcome");
      bannedBody = await response.text();
      if (bannedBody.includes("Hello!")) {
        console.log("edge is still serving the original app content", {
          status: bannedStatus,
          outcome: bannedOutcome,
        });
        return false;
      }
      return true;
    },
    {
      timeoutMs: 120_000,
      intervalMs: 2000,
      description: `banned app ${info.id} to stop serving its original content`,
    },
  );

  // The domain must still route: a banned app serves the `wasmer/disabled`
  // placeholder, it does not vanish from the Edge router. A `400` with
  // outcome `unknown_domain` means the router was tombstoned (BE-1695).
  console.log("post-ban response", {
    status: bannedStatus,
    outcome: bannedOutcome,
    body: bannedBody.slice(0, 200),
  });
  expect(bannedOutcome).not.toBe("unknown_domain");
  expect(bannedStatus).not.toBe(400);

  console.log("Unbanning app through backend API...");
  await env.backend.unbanApp({ appId: info.id });

  // The original content must come back after the unban.
  await pollUntil(
    async () => {
      const response = await env.fetchAppUrlThroughEdge(`${info.url}/`);
      const body = await response.text();
      if (response.status === 200 && body.includes("Hello!")) {
        return true;
      }
      console.log("edge is not serving the original app content yet", {
        status: response.status,
        outcome: response.headers.get("x-edge-request-outcome"),
      });
      return false;
    },
    {
      timeoutMs: 120_000,
      intervalMs: 2000,
      description: `unbanned app ${info.id} to serve its original content again`,
    },
  );

  await env.deleteApp(info);
});
