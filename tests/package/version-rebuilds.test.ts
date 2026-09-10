// Proves rebuild selection is deterministic without conflating distinct exact
// versions, so a republish cannot silently replace an artifact. See
// https://github.com/wasmerio/warp/issues/75.
import { TestEnv } from "../../src";
import { publishPackageVersion, uniquePackageName } from "../../src/package";

const TEST_TIMEOUT_MS = 600_000;

describe("package version rebuilds", () => {
  test.concurrent(
    "lifecycle categories follow stable and metadata precedence",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = uniquePackageName("lifecycle-precedence");
      const fullName = `${env.namespace}/${name}`;

      await publishPackageVersion(env, name, "1.0.0-alpha+build");
      expect(
        (await client.packages.versions.resolve(fullName, "latest"))?.version,
      ).toBe("1.0.0-alpha+build");

      await publishPackageVersion(env, name, "1.0.0-alpha");
      expect(
        (await client.packages.versions.resolve(fullName, "latest"))?.version,
      ).toBe("1.0.0-alpha");

      await publishPackageVersion(env, name, "1.0.0+build");
      expect(
        (await client.packages.versions.resolve(fullName, "latest"))?.version,
      ).toBe("1.0.0+build");

      await publishPackageVersion(env, name, "1.0.0");
      expect(
        (await client.packages.versions.resolve(fullName, "latest"))?.version,
      ).toBe("1.0.0");
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "numeric build metadata orders .11 after .2",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = uniquePackageName("rebuild-order");
      const fullName = `${env.namespace}/${name}`;
      await publishPackageVersion(env, name, "1.1.1+wasix.2");
      await publishPackageVersion(env, name, "1.1.1+wasix.11", {
        content: "newer",
      });

      const release = await client.packages.versions.resolve(fullName, "1.1.1");
      expect(release?.version).toBe("1.1.1+wasix.11");
      expect(release?.rebuilds.map((version) => version.version)).toContain(
        "1.1.1+wasix.2",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "a bare release remains distinct from a metadata release",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = uniquePackageName("bare-rebuild");
      const fullName = `${env.namespace}/${name}`;
      await publishPackageVersion(env, name, "1.1.1+foobar", {
        content: "annotated",
      });
      await publishPackageVersion(env, name, "1.1.1", { content: "bare" });

      expect(
        (await client.packages.versions.resolve(fullName, "1.1.1"))?.version,
      ).toBe("1.1.1");
      expect(
        (await client.packages.versions.resolve(fullName, "1.1.1+foobar"))
          ?.version,
      ).toBe("1.1.1+foobar");
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "an exact metadata version cannot be overwritten",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = uniquePackageName("rebuild-conflict");
      const fullName = `${env.namespace}/${name}`;
      await publishPackageVersion(env, name, "1.1.1+foobar", {
        content: "original",
      });
      const digestBefore = (
        await client.packages.versions.resolve(fullName, "1.1.1+foobar")
      )?.distribution?.piritaSha256Hash;
      if (!digestBefore) {
        throw new Error("expected the original package digest");
      }

      const result = await publishPackageVersion(env, name, "1.1.1+foobar", {
        content: "replacement",
        noAssertSuccess: true,
      });

      expect(result.code).not.toBe(0);
      expect(
        (await client.packages.versions.resolve(fullName, "1.1.1+foobar"))
          ?.distribution?.piritaSha256Hash,
      ).toBe(digestBefore);
    },
    TEST_TIMEOUT_MS,
  );
});
