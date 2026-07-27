// Proves yanking removes broken releases from normal resolution while keeping
// pinned artifacts usable. See https://github.com/wasmerio/warp/issues/75.
import { buildTempDir, TestEnv } from "../../src";
import {
  publishPackageVersion,
  publishUniquePackage,
  waitForPackageSearchState,
} from "../../src/package";

const TEST_TIMEOUT_MS = 600_000;

describe("package version yanking", () => {
  test.concurrent(
    "a yank records its lifecycle metadata",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "yank-actor");
      const fullName = `${env.namespace}/${name}`;
      const version = await client.packages.versions.resolve(fullName, "0.1.0");
      if (!version) {
        throw new Error("expected the published package version");
      }

      await client.packages.yank([version.id], { reason: "broken release" });
      const state = await client.packages.versions.resolve(fullName, "0.1.0");
      if (!state) {
        throw new Error("expected the yanked package version");
      }
      const viewer = await client.viewer();
      if (!viewer) {
        throw new Error("expected an authenticated viewer");
      }

      expect(state.yankedAt).not.toBeNull();
      expect(state.yankReason).toBe("broken release");
      expect(state.yankedBy?.username).toBe(viewer.username);
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "latest resolution skips a yanked version",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "yank-resolution");
      const fullName = `${env.namespace}/${name}`;
      await publishPackageVersion(env, name, "0.2.0");
      const version = await client.packages.versions.resolve(fullName, "0.2.0");
      if (!version) {
        throw new Error("expected version 0.2.0");
      }
      await client.packages.yank([version.id]);

      expect(
        (await client.packages.versions.resolve(fullName, "latest"))?.version,
      ).toBe("0.1.0");
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "range resolution skips a yanked version",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "yank-range-resolution");
      const fullName = `${env.namespace}/${name}`;
      await publishPackageVersion(env, name, "0.2.0");
      const version = await client.packages.versions.resolve(fullName, "0.2.0");
      if (!version) {
        throw new Error("expected version 0.2.0");
      }
      await client.packages.yank([version.id]);

      expect(
        (await client.packages.versions.resolve(fullName, ">=0.1.0"))?.version,
      ).toBe("0.1.0");
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "an exact download remains available with a warning",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "yank-download");
      const fullName = `${env.namespace}/${name}`;
      const version = await client.packages.versions.resolve(fullName, "0.1.0");
      const digest = version?.distribution?.piritaSha256Hash;
      if (!version || !digest) {
        throw new Error("expected a published package digest");
      }
      await client.packages.yank([version.id], { reason: "known issue" });

      const exact = await env.runWasmerCommand({
        args: ["package", "download", `${fullName}@=0.1.0`, "-o", "exact.webc"],
        cwd: await buildTempDir({}),
      });
      expect(`${exact.stdout}\n${exact.stderr}`).toMatch(/yanked/i);
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "a digest download remains available",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "yank-digest-download");
      const fullName = `${env.namespace}/${name}`;
      const version = await client.packages.versions.resolve(fullName, "0.1.0");
      const digest = version?.distribution?.piritaSha256Hash;
      if (!version || !digest) {
        throw new Error("expected a published package digest");
      }
      await client.packages.yank([version.id], { reason: "known issue" });

      await env.runWasmerCommand({
        args: ["package", "download", `sha256:${digest}`, "-o", "digest.webc"],
        cwd: await buildTempDir({}),
      });
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "a fully yanked package disappears from search",
    async () => {
      const env = TestEnv.fromEnv();
      const client = await env.stackmachineSdk();
      const name = await publishUniquePackage(env, "yank-search");
      const version = await waitForPackageSearchState(client, env, name, true);
      if (!version) {
        throw new Error("expected the package to appear in search");
      }
      await client.packages.yank([version.id]);

      await waitForPackageSearchState(client, env, name, false);
    },
    TEST_TIMEOUT_MS,
  );
});
