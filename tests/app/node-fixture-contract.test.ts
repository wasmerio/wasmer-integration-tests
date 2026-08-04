import * as fs from "node:fs";
import * as pathModule from "node:path";

import { AppInfo, TestEnv, randomAppName } from "../../src/index";
import { createTempDir } from "../../src/fs";
import { projectRoot } from "../utils/path";
import {
  NO_PSQL_CONFIG_RE,
  postgresRegionCandidates,
} from "../utils/app-databases";
import {
  assertDatabaseConnectivity,
  assertDatabaseEnvReport,
  assertFixtureContract,
  randomContractSuffix,
  targetFromUrl,
} from "../utils/fixture-contract";

// Validates the language-agnostic fixture contract (fixtures/openapi.yaml)
// against its Node implementation (fixtures/node), deployed through the
// remote-build (autobuild) pipeline from nothing but package.json + app.yaml.
//
// The contract assertions themselves live in tests/utils/fixture-contract.ts
// and are implementation-agnostic — this file only owns deploying the Node
// fixture in its three configurations (volume-only, MySQL, PostgreSQL).
// Database connectivity is asserted *from inside the app* (/results), which
// the psql/sql suites deliberately do not cover: they round-trip from the
// test runner only.

const REMOTE_BUILD_TIMEOUT = 15 * 60 * 1000;

const NODE_FIXTURE_DIR = pathModule.join(projectRoot, "fixtures", "node");

// Copy the fixture sources into a temp dir and write an app.yaml with the
// given extra config (volumes, database capability, region pinning). The
// fixture itself stays free of Wasmer manifests; the deploy relies on the
// remote-build node preset detecting package.json.
async function prepareDeployDir(
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

async function deployNodeFixture(
  env: TestEnv,
  appYamlExtra: string,
): Promise<AppInfo> {
  const dir = await prepareDeployDir(env, randomAppName(), appYamlExtra);
  return env.deployAppDir(dir, { extraCliArgs: ["--build-remote"] });
}

test.concurrent(
  "node-fixture-contract-endpoints",
  async () => {
    const env = TestEnv.fromEnv();

    console.log("== Deploying the Node fixture via remote build ==");
    const app = await deployNodeFixture(
      env,
      `volumes:
  - name: data
    mount: /data
`,
    );

    try {
      // The contract only ever sees the deployed app's URL; the Node
      // implementation behind it is invisible to the assertions.
      const target = targetFromUrl(env, app.url, {
        appName: app.version.name,
      });
      await assertFixtureContract(target, {
        expectDatabase: false,
        uniqueSuffix: randomContractSuffix(),
        checkLogs: true,
      });
    } finally {
      await env.deleteApp(app);
    }
  },
  REMOTE_BUILD_TIMEOUT,
);

test.concurrent(
  "node-fixture-mysql-connectivity",
  async () => {
    const env = TestEnv.fromEnv();

    console.log("== Deploying the Node fixture with a MySQL database ==");
    // Omitted engine provisions MySQL (compatibility commitment covered by
    // psql.test.ts). Pinned to a database-capable region: unpinned apps can
    // land on unhealthy Edge capacity and never become reachable.
    const candidates = await postgresRegionCandidates(env);
    const app = await deployNodeFixture(
      env,
      `capabilities:
  database: {}
${candidates.length > 0 ? `locality:\n  regions:\n    - ${candidates[0]}\n` : ""}`,
    );

    try {
      const target = targetFromUrl(env, app.url);
      await assertDatabaseEnvReport(target, { expectDatabase: true });
      console.log("== The app must reach its database from the inside ==");
      await assertDatabaseConnectivity(target, { expectDatabase: true });
    } finally {
      await env.deleteApp(app);
    }
  },
  REMOTE_BUILD_TIMEOUT,
);

test.concurrent(
  "node-fixture-postgres-connectivity",
  async () => {
    const env = TestEnv.fromEnv();

    const candidates = await postgresRegionCandidates(env);
    if (candidates.length === 0) {
      console.warn(
        "No active database-capable regions exposed by this environment; skipping PostgreSQL connectivity coverage.",
      );
      return;
    }

    console.log("== Deploying the Node fixture with a PostgreSQL database ==");
    // Region fallback mirrors deployPostgresAppWithRegionFallback, which only
    // supports AppDefinition specs; this deploy goes through a directory.
    let app: AppInfo | undefined;
    for (const region of candidates) {
      const appName = randomAppName();
      const dir = await prepareDeployDir(
        env,
        appName,
        `capabilities:
  database:
    engine: postgres
locality:
  regions:
    - ${region}
`,
      );
      try {
        app = await env.deployAppDir(dir, {
          extraCliArgs: ["--build-remote"],
        });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!NO_PSQL_CONFIG_RE.test(message)) {
          throw error;
        }
        console.warn(
          `Region ${region} has no PostgreSQL config; trying the next candidate.`,
        );
        await env.runWasmerCommand({
          args: ["app", "delete", `${env.namespace}/${appName}`],
          noAssertSuccess: true,
          quiet: true,
        });
      }
    }
    if (!app) {
      throw new Error(
        `No candidate region has a PostgreSQL database config (tried: ${candidates.join(", ")})`,
      );
    }

    try {
      const target = targetFromUrl(env, app.url);
      await assertDatabaseEnvReport(target, { expectDatabase: true });
      console.log("== The app must reach its database from the inside ==");
      await assertDatabaseConnectivity(target, { expectDatabase: true });
    } finally {
      await env.deleteApp(app);
    }
  },
  REMOTE_BUILD_TIMEOUT,
);
