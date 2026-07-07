import path from "node:path";
import { pollUntil, TestEnv, createTempDir } from "../../src";
import * as fs from "node:fs";
import * as dns from "node:dns";

test.concurrent("dns-zonefile", async () => {
  const env = TestEnv.fromEnv();
  const tmpDir = await createTempDir();

  const id = crypto.randomUUID().replace(/-/g, "");
  const domain = `${id}.com`;

  // Register the domain.
  await env.runWasmerCommand({
    args: ["domain", "register", domain],
  });

  // Get the zone file, just to make sure it works.
  const output = await env.runWasmerCommand({
    args: ["domain", "get-zone-file", domain],
  });
  let zoneFile = output.stdout;
  zoneFile += "$TTL 3600\nsub IN A 127.0.0.1";

  const subdomain = `sub.${domain}`;

  const zoneFilePath = path.join(tmpDir, "zonefile");
  await fs.promises.writeFile(zoneFilePath, zoneFile);

  // Sync the zone file.
  await env.runWasmerCommand({
    args: ["domain", "sync-zone-file", zoneFilePath],
  });

  // Resolve a server in the cluster.
  console.log("Resolving Edge DNS server ip...");
  const resolver = new dns.promises.Resolver();
  const dnsServerIp =
    env.edgeDnsServer ?? (await dns.promises.resolve4(env.appDomain))[0];
  if (!dnsServerIp) {
    throw new Error(`No DNS server configured for ${env.appDomain}`);
  }
  resolver.setServers([dnsServerIp]);
  console.log("Resolved Edge DNS server ip: " + dnsServerIp);

  // Resolve the custom domain.
  await pollUntil(
    async () => {
      console.log("Resolving custom domain", { subdomain, dnsServerIp });
      const domainRecords = await resolver.resolve4(subdomain.trim());
      console.log("Resolved", { domainRecords });
      return domainRecords.length === 1 && domainRecords[0] === "127.0.0.1";
    },
    {
      timeoutMs: 60_000,
      intervalMs: 3000,
      description: `custom domain ${subdomain} to resolve to 127.0.0.1`,
    },
  );
});
