// Shared helpers for the stackmachine-sdk-*.test.ts files. The SDK suite is
// split across several files so jest workers can run its (individually slow,
// network-bound) tests in parallel instead of serially in one file.
import {
  createZip,
  type AppAlias,
  type DeployApp,
  type DeploymentCreateInput,
  type Log,
} from "stackmachine";

import { AppInfo, pollUntil, randomAppName, sleep, TestEnv } from "../../src";

export type StackMachineClient = Awaited<
  ReturnType<TestEnv["stackmachineSdk"]>
>;

export function appFetchTarget(app: Pick<DeployApp, "id" | "url">): AppInfo {
  return {
    id: app.id,
    url: app.url,
    dir: "",
    app: {
      id: app.id,
      url: app.url,
      permalink: "",
      activeVersionId: null,
    },
    version: {
      appId: app.id,
      appVersionId: "",
      name: "",
      path: "",
      url: app.url,
    },
  };
}

export async function uploadInlineFiles(
  client: StackMachineClient,
  files: Record<string, string>,
): Promise<string> {
  const zip = await createZip(files);
  return client.files.upload(zip);
}

export async function deployUploadedApp(
  client: StackMachineClient,
  env: TestEnv,
  uploadUrl: string,
  appName = randomAppName(),
  extraInput: Partial<DeploymentCreateInput> = {},
): Promise<DeployApp> {
  const appVersion = await env.deployStackMachineApp(client, {
    appName,
    owner: env.namespace,
    uploadUrl,
    ...extraInput,
  });
  const app = appVersion.app;
  await env.recordDeployedApp({
    appId: app.id,
    appName: app.name,
    appUrl: app.url,
    appPermalink: app.url,
  });
  return app;
}

export async function deployInlinePhpApp(
  client: StackMachineClient,
  env: TestEnv,
  body: string,
  appName = randomAppName(),
  extraInput: Partial<DeploymentCreateInput> = {},
): Promise<DeployApp> {
  const uploadUrl = await uploadInlineFiles(client, {
    "index.php": body,
  });
  return deployUploadedApp(client, env, uploadUrl, appName, extraInput);
}

export async function expectAppBody(
  env: TestEnv,
  app: DeployApp,
  expectedSubstring: string,
  urlOrPath = "/",
): Promise<void> {
  const response = await env.fetchApp(appFetchTarget(app), urlOrPath, {
    forceWait: true,
  });
  const body = await response.text();
  expect(body).toContain(expectedSubstring);
}

export async function listAppDomains(
  client: StackMachineClient,
  appId: string,
): Promise<AppAlias[]> {
  return (await client.apps.domains.list({ app: appId })).data;
}

export async function waitForLogs(
  client: StackMachineClient,
  app: DeployApp,
  substring: string,
  timeoutMs = 200_000,
): Promise<void> {
  const start = Date.now();
  let latestLogs: Log[] | undefined;
  while (Date.now() - start < timeoutMs) {
    if (app.activeVersion) {
      latestLogs = (
        await client.apps.versions.logs.list({
          version: app.activeVersion.id,
          since: new Date(Date.now() - 30 * 60 * 1000),
        })
      ).data;
    }
    if (latestLogs?.some((entry) => entry.message.includes(substring))) {
      return;
    }
    await sleep(3_000);
  }
  throw new Error(
    [
      `Timed out waiting for logs containing '${substring}' for app '${app.id}' (${app.url})`,
      "Latest logs:",
      ...(latestLogs ?? []).map((entry) => {
        const datetime =
          entry.datetime instanceof Date
            ? entry.datetime.toISOString()
            : String(entry.datetime);
        return `${datetime} ${entry.stream} ${entry.instanceId} ${entry.message}`;
      }),
    ].join("\n"),
  );
}

export async function waitForDeletion(
  client: StackMachineClient,
  appId: string,
  timeoutMs = 60_000,
): Promise<void> {
  await pollUntil(
    async () => {
      const [app] = await client.apps.retrieveMany([appId]);
      return !app;
    },
    { timeoutMs, intervalMs: 2_000, description: `deletion of app '${appId}'` },
  );
}

export async function waitForDomainDeletion(
  client: StackMachineClient,
  appId: string,
  aliasId: string,
  timeoutMs = 60_000,
): Promise<void> {
  await pollUntil(
    async () => {
      const domains = await listAppDomains(client, appId);
      return !domains.find((item) => item.id === aliasId);
    },
    {
      timeoutMs,
      intervalMs: 2_000,
      description: `deletion of domain '${aliasId}'`,
    },
  );
}

export async function addDomain(
  client: StackMachineClient,
  env: TestEnv,
  app: DeployApp,
): Promise<{ alias: AppAlias; domainName: string }> {
  const zone = `${crypto.randomUUID().replace(/-/g, "")}.com`;
  const domainName = `www.${zone}`;

  await env.runWasmerCommand({
    args: ["domain", "register", zone],
  });

  const alias = await client.apps.domains.create({
    app: app.id,
    hostname: domainName,
  });
  expect(alias.expectedDnsRecords.length).toBeGreaterThan(0);
  return { alias, domainName };
}

export async function waitForDomainPresent(
  client: StackMachineClient,
  appId: string,
  aliasId: string,
  timeoutMs = 60_000,
): Promise<AppAlias> {
  return pollUntil(
    async () => {
      const domains = await listAppDomains(client, appId);
      return domains.find((item) => item.id === aliasId);
    },
    {
      timeoutMs,
      intervalMs: 2_000,
      description: `domain '${aliasId}' to be attached`,
    },
  );
}

/**
 * Install the canonical SDK-app cleanup hook for the current test file and
 * return the id list tests should push deployed apps onto. Apps are deleted
 * after each test unless the test failed (or KEEP_APPS is set), in which case
 * they are preserved for inspection.
 */
export function installSdkAppCleanup(): string[] {
  const cleanupAppIds: string[] = [];

  afterEach(async () => {
    const env = TestEnv.fromEnv();
    if (env.shouldPreserveAppsForCurrentTest()) {
      cleanupAppIds.length = 0;
      return;
    }

    while (cleanupAppIds.length > 0) {
      const appId = cleanupAppIds.pop();
      if (!appId) {
        continue;
      }
      try {
        await env.backend.deleteApp(appId);
      } catch {
        // Ignore cleanup races when the test already deleted the app.
      }
    }
  });

  return cleanupAppIds;
}
