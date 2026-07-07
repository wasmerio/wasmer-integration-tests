import { type SearchPackageVersion } from "stackmachine";

import { buildTempDir, pollUntil, TestEnv } from "../../src";
import { type StackMachineClient } from "../utils/stackmachine-sdk";

jest.setTimeout(600_000);

// Publish a fresh, uniquely-named package to the test namespace so search has
// something deterministic to find. Returns the bare package name (without the
// owner).
async function publishUniquePackage(env: TestEnv): Promise<string> {
  const name = `sdk-search-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const fullName = `${env.namespace}/${name}`;
  const pkgDir = await buildTempDir({
    "wasmer.toml": `
[package]
name = "${fullName}"
version = "0.1.0"

[dependencies]
"wasmer/static-web-server" = "1"

[fs]
"/public" = "public"

[[command]]
name = "script"
module = "wasmer/static-web-server:webserver"
runner = "https://webc.org/runner/wasi"
`,
    public: {
      "index.html": name,
    },
  });
  await env.runWasmerCommand({ args: ["publish"], cwd: pkgDir });
  return name;
}

// Search indexing is asynchronous after publish, so poll until the package
// shows up; on timeout the raised error carries the most recent results for
// debugging.
async function waitForPackageInSearch(
  client: StackMachineClient,
  env: TestEnv,
  packageName: string,
  timeoutMs = 120_000,
): Promise<SearchPackageVersion> {
  return pollUntil(
    async () => {
      const page = await client.packages.search({
        query: packageName,
        filter: { owner: env.namespace },
      });
      const match = page.data.find(
        (result) =>
          result.package.namespace === env.namespace &&
          result.package.packageName === packageName,
      );
      if (!match) {
        const seen = page.data.map(
          (result) =>
            `${result.package.namespace}/${result.package.packageName}`,
        );
        throw new Error(`last results: ${seen.join(", ") || "(none)"}`);
      }
      return match;
    },
    {
      timeoutMs,
      intervalMs: 5_000,
      description: `package '${env.namespace}/${packageName}' to appear in search`,
    },
  );
}

describe("stackmachine sdk", () => {
  test("searchPackagesByOwner example", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();

    const name = await publishUniquePackage(env);

    const result = await waitForPackageInSearch(client, env, name);
    expect(result.package.namespace).toBe(env.namespace);
    expect(result.package.packageName).toBe(name);
    expect(result.version).toBe("0.1.0");
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.package.lastVersion?.version).toBe("0.1.0");

    const ownerScoped = await client.packages.search({
      filter: { owner: env.namespace },
      limit: 50,
    });
    // a package for that owner must exist
    expect(ownerScoped.data.length).toBeGreaterThan(0);
    // and all returned packages must belong to the queried owner
    for (const entry of ownerScoped.data) {
      expect(entry.package.namespace).toBe(env.namespace);
    }

    const otherOwner = await client.packages.search({
      query: name,
      filter: { owner: "wasmer" },
    });
    // the package should *not* be returned when filtering for a different owner
    expect(
      otherOwner.data.some((entry) => entry.package.packageName === name),
    ).toBe(false);
  });
});
