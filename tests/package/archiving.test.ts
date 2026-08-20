// Proves archived packages leave discovery without breaking pinned downloads,
// so maintainers can retire a package safely. See https://github.com/wasmerio/warp/issues/75.
import { buildTempDir, TestEnv } from "../../src";
import {
  publishUniquePackage,
  waitForPackageSearchState,
} from "../../src/package";

const TEST_TIMEOUT_MS = 600_000;

describe("package archiving", () => {
  test.concurrent(
    "archiving records the actor",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "archive-actor");
      const fullName = `${env.namespace}/${name}`;

      await client.packages.archive(fullName);
      const archived = await client.packages.retrieve(fullName);
      const viewer = await client.viewer();
      if (!viewer) {
        throw new Error("expected an authenticated viewer");
      }
      expect(archived.isArchived).toBe(true);
      expect(archived.archivedBy?.username).toBe(viewer.username);
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "unarchiving clears the actor",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "unarchive-actor");
      const fullName = `${env.namespace}/${name}`;
      await client.packages.archive(fullName);

      await client.packages.unarchive(fullName);

      const restored = await client.packages.retrieve(fullName);
      expect(restored.isArchived).toBe(false);
      expect(restored.archivedBy).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "an archived package disappears from search",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "archive-search");
      const fullName = `${env.namespace}/${name}`;
      await waitForPackageSearchState(client, env, name, true);

      await client.packages.archive(fullName);

      await waitForPackageSearchState(client, env, name, false);
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "an exact download remains available",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "archive-download");
      const fullName = `${env.namespace}/${name}`;
      const version = await client.packages.versions.resolve(fullName, "0.1.0");
      const digest = version?.distribution?.piritaSha256Hash;
      if (!version || !digest) {
        throw new Error("expected a published package digest");
      }
      await client.packages.archive(fullName);

      await env.runWasmerCommand({
        args: ["package", "download", `${fullName}@=0.1.0`, "-o", "exact.webc"],
        cwd: await buildTempDir({}),
      });
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "a digest download remains available",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "archive-digest-download");
      const fullName = `${env.namespace}/${name}`;
      const version = await client.packages.versions.resolve(fullName, "0.1.0");
      const digest = version?.distribution?.piritaSha256Hash;
      if (!digest) {
        throw new Error("expected a published package digest");
      }
      await client.packages.archive(fullName);

      await env.runWasmerCommand({
        args: ["package", "download", `sha256:${digest}`, "-o", "digest.webc"],
        cwd: await buildTempDir({}),
      });
    },
    TEST_TIMEOUT_MS,
  );
});
