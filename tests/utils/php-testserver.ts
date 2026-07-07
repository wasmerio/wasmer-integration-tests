import * as path from "node:path";

import type { AppDefinition } from "../../src";
import { randomAppName, TestEnv, writeAppDefinition } from "../../src";
import { copyPackageAnonymous } from "../../src/package";
import { projectRoot } from "./path";

export interface PhpTestserverOptions {
  // Volume mount path inside the instance. Defaults to "/data".
  volumeMount?: string;
  // App name. Defaults to a random test app name.
  name?: string;
}

/**
 * Prepare a deployable copy of the wasmopticon php-testserver package with a
 * single "data" volume and debug mode (instance purging) enabled.
 *
 * Returns the prepared directory (pass to env.deployAppDir) and the written
 * AppDefinition, which callers may mutate and re-write for redeploy flows.
 */
export async function preparePhpTestserverApp(
  env: TestEnv,
  options: PhpTestserverOptions = {},
): Promise<{ dir: string; definition: AppDefinition }> {
  const rootPackageDir = path.join(
    projectRoot,
    "wasmopticon",
    "php",
    "php-testserver",
  );
  const dir = await copyPackageAnonymous(rootPackageDir);

  const definition: AppDefinition = {
    appYaml: {
      kind: "wasmer.io/App.v0",
      name: options.name ?? randomAppName(),
      owner: env.namespace,
      package: ".",
      // Enable debug mode to allow instance purging.
      debug: true,
      volumes: [
        {
          name: "data",
          mount: options.volumeMount ?? "/data",
        },
      ],
    },
  };
  await writeAppDefinition(dir, definition);
  return { dir, definition };
}
