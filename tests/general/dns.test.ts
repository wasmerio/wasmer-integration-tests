import path from "path";
import { TestEnv, createTempDir, sleep } from "../../src";
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
  const aRecords = await dns.promises.resolve4(env.appDomain);
  if (aRecords.length === 0) {
    throw new Error(`No DNS A records found for ${env.appDomain}`);
  }
  const dnsServerIp = aRecords[0];
  const resolver = new dns.promises.Resolver();
  resolver.setServers([dnsServerIp]);
  console.log("Resolved Edge DNS server ip: " + dnsServerIp);

  // Resolve the custom domain.
  const start = Date.now();
  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed > 60_000) {
      throw new Error(
        "Timeout while waiting for DNS records to become available",
      );
    }

    console.log("Resolving custom domain", { subdomain, dnsServerIp });
    let domainRecords: string[];

    try {
      domainRecords = await resolver.resolve4(subdomain.trim());
    } catch (error) {
      console.error("Error while resolving DNS records ... retrying ...", {
        error,
      });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }

    console.log("Resolved", { domainRecords });
    const isMatch =
      domainRecords.length === 1 && domainRecords[0] === "127.0.0.1";
    if (isMatch) {
      break;
    } else {
      console.log("DNS records do not match yet, waiting...", {
        domainRecords,
      });
      await sleep(3_000);
    }
  }
});
