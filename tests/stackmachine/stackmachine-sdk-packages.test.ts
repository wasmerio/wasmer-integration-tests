import { TestEnv } from "../../src";
import {
  publishPackageVersion,
  publishUniquePackage,
  waitForPackageSearchState,
} from "../../src/package";

const TEST_TIMEOUT_MS = 600_000;

describe("stackmachine sdk packages", () => {
  test.concurrent(
    "search maps owner-scoped package results",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "sdk-search");

      const result = await waitForPackageSearchState(client, env, name, true);
      if (!result) {
        throw new Error("expected the package to appear in search");
      }
      expect(result.package.namespace).toBe(env.namespace);
      expect(result.package.packageName).toBe(name);
      expect(result.version).toBe("0.1.0");
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.package.lastVersion?.version).toBe("0.1.0");

      const otherOwner = await client.packages.search({
        query: name,
        filter: { owner: "wasmer" },
      });
      expect(
        otherOwner.data.some((entry) => entry.package.packageName === name),
      ).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "yank maps lifecycle fields",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "sdk-yank");
      await publishPackageVersion(env, name, "0.2.0");
      const result = await waitForPackageSearchState(
        client,
        env,
        name,
        true,
        120_000,
        "0.2.0",
      );
      if (!result) {
        throw new Error("expected version 0.2.0 to appear in search");
      }

      const yanked = await client.packages.yank([result.id], {
        reason: "integration test",
      });
      expect(yanked.map((version) => version.version)).toEqual(["0.2.0"]);
      expect(yanked[0].yankedAt).not.toBeNull();
      expect(yanked[0].yankReason).toBe("integration test");
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "unyank clears lifecycle fields",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "sdk-unyank");
      const result = await waitForPackageSearchState(client, env, name, true);
      if (!result) {
        throw new Error("expected the package to appear in search");
      }
      await client.packages.yank([result.id], { reason: "integration test" });

      const restored = await client.packages.unyank([result.id]);

      expect(restored.map((version) => version.version)).toEqual(["0.1.0"]);
      expect(restored[0].yankedAt).toBeNull();
      expect(restored[0].yankReason).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "archive maps package state",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "sdk-archive");
      const fullName = `${env.namespace}/${name}`;

      await expect(client.packages.archive(fullName)).resolves.toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "unarchive maps package state",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "sdk-unarchive");
      const fullName = `${env.namespace}/${name}`;
      await client.packages.archive(fullName);

      await expect(client.packages.unarchive(fullName)).resolves.toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
