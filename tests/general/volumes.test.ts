// Volume tests
import * as path from "node:path";

import { assertEquals } from "../../src/testing_tools";

import { copyPackageAnonymous } from "../../src/package";
import { randomAppName } from "../../src/app/construct";

import {
  AppDefinition,
  HEADER_INSTANCE_ID,
  HEADER_PURGE_INSTANCES,
  TestEnv,
  wasmopticonDir,
  writeAppDefinition,
} from "../../src/index";

test("app-volumes", async () => {
  const env = TestEnv.fromEnv();

  const rootPackageDir = path.join(
    await wasmopticonDir(),
    "php/php-testserver",
  );
  const dir = await copyPackageAnonymous(rootPackageDir);

  const app: AppDefinition = {
    appYaml: {
      kind: "wasmer.io/App.v0",
      name: randomAppName(),
      owner: env.namespace,
      package: ".",
      // Enable debug mode to allow instance purging.
      debug: true,
      volumes: [
        {
          name: "data",
          mount: "/data",
        },
      ],
    },
  };
  writeAppDefinition(dir, app);

  const info = await env.deployAppDir(dir);

  const file1Content = "value1";

  // Write a file to the volume.
  await env.fetchApp(info, "/fs/write/data/file1", {
    method: "POST",
    body: file1Content,
    discardBody: true,
  });

  // Read the file.
  {
    const resp = await env.fetchApp(info, "/fs/read/data/file1");
    const body = await resp.text();
    assertEquals(body, file1Content);
  }

  // Now read again, but force a fresh instance to make sure it wasn't just
  // stored in memory.
  {
    const resp = await env.fetchApp(info, "/fs/read/data/file1", {
      headers: {
        [HEADER_PURGE_INSTANCES]: "1",
      },
    });
    const body = await resp.text();
    assertEquals(body, file1Content);
  }
  await env.deleteApp(info);
});

// Test that a volume can be mounted inside a directory mounted from a package.
test("volume-mount-inside-package-dir", async () => {
  const env = TestEnv.fromEnv();

  const rootPackageDir = path.join(
    await wasmopticonDir(),
    "php/php-testserver",
  );
  const dir = await copyPackageAnonymous(rootPackageDir);

  // The PHP testserver mounts code at /app, so we'll mount a volume inside that.

  const app: AppDefinition = {
    appYaml: {
      kind: "wasmer.io/App.v0",
      name: randomAppName(),
      owner: env.namespace,
      package: ".",
      // Enable debug mode to allow instance purging.
      debug: true,
      volumes: [
        {
          name: "data",
          mount: "/app/data",
        },
      ],
    },
  };
  writeAppDefinition(dir, app);

  const info = await env.deployAppDir(dir);

  const file1Content = "value1";

  const filePath = "/app/data/file1";

  // Write a file to the volume.
  await env.fetchApp(info, `/fs/write${filePath}`, {
    method: "POST",
    body: file1Content,
    discardBody: true,
  });

  // Read the file.
  let firstInstanceId: string;
  {
    const resp = await env.fetchApp(info, `/fs/read${filePath}`);
    const body = await resp.text();
    assertEquals(body, file1Content);
    const id = resp.headers.get(HEADER_INSTANCE_ID);
    expect(id).toBeTruthy();
    firstInstanceId = id!;
  }
  expect(firstInstanceId).toBeTruthy();

  // Now read again, but force a fresh instance to make sure it wasn't just
  // stored in memory.
  {
    const resp = await env.fetchApp(info, `/fs/read${filePath}`, {
      headers: {
        [HEADER_PURGE_INSTANCES]: "1",
      },
    });
    const body = await resp.text();
    assertEquals(body, file1Content);

    const secondInstanceId = resp.headers.get(HEADER_INSTANCE_ID);
    expect(secondInstanceId).toBeTruthy();
    // Make sure the response was served from a different instance.
    expect(firstInstanceId).not.toBe(secondInstanceId);
  }
  await env.deleteApp(info);
});
