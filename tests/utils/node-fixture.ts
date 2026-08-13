import * as fs from "node:fs";
import * as pathModule from "node:path";

import { AppInfo, TestEnv, randomAppName } from "../../src/index";
import { createTempDir } from "../../src/fs";
import { projectRoot } from "./path";

// Deployment of the Node fixture (fixtures/node), shared by the HTTP and
// WebSocket contract suites. The fixture itself stays free of Wasmer
// manifests; the deploy relies on the remote-build node preset detecting
// package.json.

export const NODE_FIXTURE_DIR = pathModule.join(
  projectRoot,
  "fixtures",
  "node",
);

export const REMOTE_BUILD_TIMEOUT = 15 * 60 * 1000;

/**
 * Copy the fixture sources into a temp dir and write an app.yaml with the
 * given extra config (volumes, database capability, region pinning).
 */
export async function prepareNodeFixtureDir(
  env: TestEnv,
  appName: string,
  appYamlExtra: string,
): Promise<string> {
  const dir = await createTempDir();
  for (const entry of ["package.json", "src"]) {
    await fs.promises.cp(
      pathModule.join(NODE_FIXTURE_DIR, entry),
      pathModule.join(dir, entry),
      { recursive: true },
    );
  }
  const appYaml = `kind: wasmer.io/App.v0
name: ${appName}
owner: ${env.namespace}
package: .
${appYamlExtra}`;
  await fs.promises.writeFile(pathModule.join(dir, "app.yaml"), appYaml);
  return dir;
}

export async function deployNodeFixture(
  env: TestEnv,
  appYamlExtra: string,
): Promise<AppInfo> {
  const dir = await prepareNodeFixtureDir(env, randomAppName(), appYamlExtra);
  return env.deployAppDir(dir, { extraCliArgs: ["--build-remote"] });
}
