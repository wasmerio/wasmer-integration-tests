import * as fs from "node:fs";
import * as pathModule from "node:path";

import { AppInfo, TestEnv, randomAppName } from "../../src/index";
import { createTempDir } from "../../src/fs";
import { projectRoot } from "./path";

// Deployment of the Python fixture (fixtures/python/toolbox), shared by the
// HTTP and WebSocket contract suites. Only the sources are copied — never
// the local .venv or .shipit build output — and the deploy relies on the
// remote-build python preset (Anybuild) like python-compatibility.test.ts.

export const PYTHON_FIXTURE_DIR = pathModule.join(
  projectRoot,
  "fixtures",
  "python",
  "toolbox",
);

export const PYTHON_REMOTE_BUILD_TIMEOUT = 15 * 60 * 1000;

/**
 * Copy the fixture sources into a temp dir and write an app.yaml with the
 * given extra config (volumes, database capability, region pinning).
 */
export async function preparePythonFixtureDir(
  env: TestEnv,
  appName: string,
  appYamlExtra: string,
): Promise<string> {
  const dir = await createTempDir();
  for (const entry of ["pyproject.toml", "uv.lock", "Anybuild", "src"]) {
    await fs.promises.cp(
      pathModule.join(PYTHON_FIXTURE_DIR, entry),
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

export async function deployPythonFixture(
  env: TestEnv,
  appYamlExtra: string,
): Promise<AppInfo> {
  const dir = await preparePythonFixtureDir(env, randomAppName(), appYamlExtra);
  return env.deployAppDir(dir, { extraCliArgs: ["--build-remote"] });
}
