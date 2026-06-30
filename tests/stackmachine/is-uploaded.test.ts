// Regression test for BE-1610.
// https://linear.app/wasmer/issue/BE-1610
//
// Bug: the app-header "Upload files" button disappears after any config-only
// edit (add storage, env var, scale, domain, or editing app.yaml in the
// dashboard). The button is gated on `activeVersion.isUploaded`, which the
// backend resolves *only* against the active version's ZipRollout
// (`resolve_is_uploaded` / Rust `has_zip_rollout_for_version`). A config-only
// re-publish reuses the existing package and creates no new ZipRollout, so the
// freshly-active version reports `isUploaded = false` even though the app was
// originally deployed by uploading files.
//
// This test deploys an app via the "Upload files" path (zip upload -> autobuild,
// which DOES create a ZipRollout), then mirrors the dashboard "edit app.yaml"
// path (`publishDeployApp` with `config.yamlConfig` + `makeDefault: true`) to
// re-version it WITHOUT a new upload, and asserts that the button gate
// (`isUploaded`) still holds for an app that has upload history.
//
// Correct behavior: `isUploaded` should fall back to app-level — true if any
// non-deleted version of the app has a ZipRollout — so re-versioning via a
// config edit never strips the "Upload files" button.

import { createZip } from "stackmachine";
import * as yaml from "js-yaml";

import { assertEquals, assertNotEquals } from "../../src/testing_tools";
import { AppInfo, randomAppName, sleep, TestEnv } from "../../src/index";

jest.setTimeout(600_000);

const ACTIVE_VERSION_QUERY = `
  query ($id: ID!) {
    node(id: $id) {
      ... on DeployApp {
        activeVersion {
          id
          isUploaded
          userYamlConfig
        }
      }
    }
  }
`;

const PUBLISH_DEPLOY_APP = `
  mutation ($input: PublishDeployAppInput!) {
    publishDeployApp(input: $input) {
      deployAppVersion {
        id
        isUploaded
      }
    }
  }
`;

interface ActiveVersion {
  id: string;
  isUploaded: boolean;
  userYamlConfig: string;
}

// Minimal shape of the app returned by the StackMachine SDK (typed `unknown`).
interface DeployAppLike {
  id: string;
  name: string;
  url: string;
}

async function getActiveVersion(
  env: TestEnv,
  appId: string,
): Promise<ActiveVersion> {
  const res = await env.backend.gqlQuery<{
    node: { activeVersion: ActiveVersion };
  }>(ACTIVE_VERSION_QUERY, { id: appId });
  return res.data.node.activeVersion;
}

// Minimal AppInfo so env.deleteApp() (which only needs id + version.name) can
// clean up an app deployed through the StackMachine SDK.
function deletable(id: string, name: string, url: string): AppInfo {
  return {
    id,
    url,
    dir: "",
    app: { id, url, permalink: "", activeVersionId: null },
    version: { appId: id, appVersionId: "", name, path: "", url },
  };
}

test("BE-1610: isUploaded survives a config-only re-version", async () => {
  const env = TestEnv.fromEnv();
  const client = await env.stackmachineSdk();
  const appName = randomAppName();

  // 1. Deploy via the "Upload files" path: zip the files, upload, deploy from
  //    the upload URL. This is an autobuild-from-zip and DOES create a
  //    ZipRollout, so the "Upload files" button is available.
  const zip = await createZip({
    "index.php": "<html><body>BE-1610</body></html>",
  });
  const uploadUrl = await client.uploadFile(zip);
  const build = await client.deployApp({
    appName,
    owner: env.namespace,
    uploadUrl,
  });
  const appVersion = await build.finish();
  const app = appVersion.app as DeployAppLike;
  await env.recordDeployedApp({
    appId: app.id,
    appName: app.name,
    appUrl: app.url,
    appPermalink: app.url,
  });

  try {
    // Baseline: an uploaded deploy has a ZipRollout.
    const uploaded = await getActiveVersion(env, app.id);
    assertEquals(
      uploaded.isUploaded,
      true,
      "baseline: uploaded app has a ZipRollout",
    );

    // 2. Reproduce the dashboard "edit app.yaml" / "add storage" path: re-publish
    //    the SAME package with a changed config. This mints a new active version
    //    via the `graphql` client with NO ZipRollout. Any config-only change does
    //    it; `debug: true` is a harmless, always-valid edit.
    const cfg = yaml.load(uploaded.userYamlConfig) as Record<string, unknown>;
    cfg.debug = true;
    const yamlConfig = yaml.dump(cfg);

    await env.backend.gqlQuery(PUBLISH_DEPLOY_APP, {
      input: {
        owner: env.namespace,
        name: app.name,
        config: { yamlConfig },
        makeDefault: true,
      },
    });

    // Wait for the re-published version to become active.
    let after = await getActiveVersion(env, app.id);
    for (let i = 0; i < 15 && after.id === uploaded.id; i++) {
      await sleep(2000);
      after = await getActiveVersion(env, app.id);
    }
    assertNotEquals(
      after.id,
      uploaded.id,
      "config edit must re-version the app",
    );

    // 3. The app still has upload history, so the "Upload files" button must
    //    remain available after the config-only re-version.
    assertEquals(
      after.isUploaded,
      true,
      "BE-1610: isUploaded must stay true after a config-only re-version",
    );
  } finally {
    await env.deleteApp(deletable(app.id, app.name, app.url));
  }
});
