import * as fs from "node:fs";
import * as pathModule from "node:path";

import { z } from "zod";

import { TestEnv, randomAppName } from "../../src/index";
import { createTempDir } from "../../src/fs";

// Repro for BE-1679 — publish to an existing app with empty domains wipes
// all non-UI aliases:
// https://linear.app/wasmer/issue/BE-1679/publish-to-existing-app-with-empty-domains-wipes-all-non-ui-aliases
//
// This is the mechanism behind the 2026-07-08 → 2026-07-23 prod incident on
// `msdizajn.wasmer.app` (hivemind KB, backend BE-1676 family):
//
// Every publish that goes through the autobuild pipeline — GitHub webhook
// rebuilds, dashboard deploys and `wasmer deploy --build-remote` — reaches
// `publish_version_to_existing_app_with_auth` (sm_be_apps/src/workflow/app.rs)
// with the request's `domains` as the *complete* alias keep-list. Remote
// builds send no domains unless `app.yaml` has a `domains:` key, and
// `soft_delete_aliases_for_app` treats an empty keep-list as "delete every
// active alias with is_added_by_ui = false".
//
// Two observable failure modes, one test each:
//
// 1. App with only its generated deployment alias: the alias row is
//    soft-deleted and a replacement with the same text is generated, so the
//    URL keeps working but the alias identity silently churns on every
//    remote-build redeploy.
// 2. App that also has a UI-added default domain (`upsertAppDomain`, the
//    dashboard "add domain" flow — the msdizajn setup): the app still has a
//    default alias after the wipe, so nothing regenerates the deployment
//    alias and its URL turns into an Edge `unknown_domain` 400.
//
// These tests assert the *correct* behavior, so they are expected to stay
// red until BE-1679 is resolved. That is intentional: the suite reflects the
// current state of the product, and this file is the fastest path to a green
// pipeline — fixing the backend makes it pass as-is, and it then remains in
// place as the permanent regression test. Please do not skip, quarantine, or
// invert these tests; coordinate on the ticket instead.

const REMOTE_BUILD_TIMEOUT = 15 * 60 * 1000;

const AliasNode = z.object({
  id: z.string(),
  text: z.string(),
  isDefault: z.boolean(),
});
type AliasNode = z.infer<typeof AliasNode>;

const AppAliasesResult = z.object({
  getDeployApp: z.object({
    id: z.string(),
    url: z.string(),
    aliases: z.object({
      edges: z.array(z.object({ node: AliasNode })),
    }),
  }),
});

interface AppAliasState {
  appId: string;
  url: string;
  aliases: AliasNode[];
}

async function getAppAliasState(
  env: TestEnv,
  appName: string,
): Promise<AppAliasState> {
  const query = `
    query($name: String!, $owner: String!) {
      getDeployApp(name: $name, owner: $owner) {
        id
        url
        aliases(first: 20) {
          edges {
            node {
              id
              text
              isDefault
            }
          }
        }
      }
    }
  `;
  const res = await env.backend.gqlQuery<unknown>(query, {
    name: appName,
    owner: env.namespace,
  });
  const parsed = AppAliasesResult.parse(res.data);
  return {
    appId: parsed.getDeployApp.id,
    url: parsed.getDeployApp.url,
    aliases: parsed.getDeployApp.aliases.edges.map((edge) => edge.node),
  };
}

async function addUiDefaultDomain(
  env: TestEnv,
  appId: string,
  domain: string,
): Promise<void> {
  const mutation = `
    mutation($appId: ID!, $name: String!) {
      upsertAppDomain(input: { appId: $appId, name: $name, isDefault: true }) {
        success
      }
    }
  `;
  await env.backend.gqlQuery(mutation, { appId, name: domain });
}

// `wasmer app create --template` only scaffolds locally; the backend app (and
// its default alias) is created by the first deploy.
async function scaffoldTemplateApp(
  env: TestEnv,
): Promise<{ appName: string; dir: string }> {
  const appName = randomAppName();
  const dir = await createTempDir();
  await env.runWasmerCommand({
    args: [
      "app",
      "create",
      "--name",
      appName,
      "--non-interactive",
      "--template",
      "static-website",
      "--owner",
      env.namespace,
    ],
    cwd: dir,
  });
  return { appName, dir };
}

// After a remote deploy the CLI merges backend annotations into app.yaml and
// currently writes invalid YAML (the first `annotations:` child key loses its
// indentation), which breaks the next deploy. Overwrite with a minimal valid
// config; `app_id` pins the redeploy to the existing app.
function writeMinimalAppYaml(
  dir: string,
  appName: string,
  owner: string,
  appId: string,
): void {
  const yaml = `kind: wasmer.io/App.v0
name: ${appName}
owner: ${owner}
package: .
app_id: ${appId}
`;
  fs.writeFileSync(pathModule.join(dir, "app.yaml"), yaml);
}

async function remoteBuildDeploy(env: TestEnv, dir: string): Promise<void> {
  await env.runWasmerCommand({
    args: [
      "deploy",
      "--owner",
      env.namespace,
      "--build-remote",
      "--non-interactive",
    ],
    cwd: dir,
  });
}

async function cleanupApp(env: TestEnv, appName: string): Promise<void> {
  await env.runWasmerCommand({
    args: ["app", "delete", `${env.namespace}/${appName}`],
    noAssertSuccess: true,
  });
}

describe("BE-1679: remote-build (autobuild) redeploy alias preservation", () => {
  test.concurrent(
    "preserves the deployment alias row across a remote-build redeploy",
    async () => {
      const env = TestEnv.fromEnv();
      const { appName, dir } = await scaffoldTemplateApp(env);
      try {
        await remoteBuildDeploy(env, dir);

        const defaultAliasText = `${appName}.${env.appDomain}`;
        const before = await getAppAliasState(env, appName);
        const originalAlias = before.aliases.find(
          (alias) => alias.text === defaultAliasText,
        );
        expect(originalAlias).toBeDefined();

        writeMinimalAppYaml(dir, appName, env.namespace, before.appId);
        await remoteBuildDeploy(env, dir);

        const after = await getAppAliasState(env, appName);
        const survivor = after.aliases.find(
          (alias) => alias.text === defaultAliasText,
        );
        expect(survivor).toBeDefined();
        // The publish must keep the existing alias row. A different ID means
        // the empty keep-list wiped the alias and a replacement was generated:
        // same text by luck, but a delete+recreate churn on every redeploy.
        expect(survivor?.id).toBe(originalAlias?.id);
      } finally {
        await cleanupApp(env, appName);
      }
    },
    REMOTE_BUILD_TIMEOUT,
  );

  test.concurrent(
    "keeps the deployment alias when a UI-added default domain exists",
    async () => {
      const env = TestEnv.fromEnv();
      const { appName, dir } = await scaffoldTemplateApp(env);
      try {
        await remoteBuildDeploy(env, dir);

        const defaultAliasText = `${appName}.${env.appDomain}`;
        const before = await getAppAliasState(env, appName);
        expect(
          before.aliases.some((alias) => alias.text === defaultAliasText),
        ).toBe(true);

        // Mirror the incident setup: a dashboard-added domain that is the
        // app's selected default (msdizajn had `www.msdizajn.com`).
        const uiDomain = `${appName}-keep.${env.appDomain}`;
        await addUiDefaultDomain(env, before.appId, uiDomain);

        writeMinimalAppYaml(dir, appName, env.namespace, before.appId);
        await remoteBuildDeploy(env, dir);

        const after = await getAppAliasState(env, appName);
        const aliasTexts = after.aliases.map((alias) => alias.text);
        // The UI-added domain must survive, and so must the deployment alias.
        // On the broken backend the deployment alias is wiped and — because a
        // default alias still exists — never regenerated, so the app's
        // original URL stops routing entirely (Edge unknown_domain).
        expect(aliasTexts).toContain(uiDomain);
        expect(aliasTexts).toContain(defaultAliasText);

        const response = await env.fetchAppUrlThroughEdge(
          `https://${defaultAliasText}/`,
        );
        await response.body?.cancel();
        expect(response.status).toBeLessThan(400);
      } finally {
        await cleanupApp(env, appName);
      }
    },
    REMOTE_BUILD_TIMEOUT,
  );
});
