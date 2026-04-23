import { createZip } from "stackmachine";
import { AppInfo, randomAppName, sleep, TestEnv } from "../../src";

jest.setTimeout(600_000);

type StackMachineClient = Awaited<ReturnType<TestEnv["stackmachineSdk"]>>;

interface AppAliasLike {
  id: string;
  url: string;
  expectedDnsRecords: { host: string; recordType: string; value: string }[];
  verify(): Promise<boolean>;
  delete(): Promise<void>;
}

interface DeployAppLike {
  id: string;
  name: string;
  url: string;
  adminUrl?: string;
  willPerishAt: Date | null;
  activeVersion: {
    id: string;
    fetchLogs(since: Date): Promise<
      {
        datetime: Date;
        instanceId: string;
        message: string;
        stream: string;
        timestamp: number;
      }[]
    >;
  } | null;
  upsertDomain(domain: string): Promise<AppAliasLike>;
  domains: { id: string; url: string }[];
}

function appFetchTarget(app: Pick<DeployAppLike, "id" | "url">): AppInfo {
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

async function uploadInlineFiles(
  client: StackMachineClient,
  files: Record<string, string>,
): Promise<string> {
  const zip = await createZip(files);
  return client.uploadFile(zip);
}

async function deployUploadedApp(
  client: StackMachineClient,
  env: TestEnv,
  uploadUrl: string,
  appName = randomAppName(),
  extraInput: Record<string, unknown> = {},
): Promise<DeployAppLike> {
  const build = await client.deployApp({
    appName,
    owner: env.namespace,
    uploadUrl,
    ...extraInput,
  });

  const appVersion = await build.finish();
  return appVersion.app as DeployAppLike;
}

async function deployInlinePhpApp(
  client: StackMachineClient,
  env: TestEnv,
  body: string,
  appName = randomAppName(),
  extraInput: Record<string, unknown> = {},
): Promise<DeployAppLike> {
  const uploadUrl = await uploadInlineFiles(client, {
    "index.php": body,
  });
  return deployUploadedApp(client, env, uploadUrl, appName, extraInput);
}

async function expectAppBody(
  env: TestEnv,
  app: DeployAppLike,
  expectedSubstring: string,
  urlOrPath = "/",
): Promise<void> {
  const response = await env.fetchApp(appFetchTarget(app), urlOrPath, {
    forceWait: true,
  });
  const body = await response.text();
  expect(body).toContain(expectedSubstring);
}

async function waitForLogs(
  app: DeployAppLike,
  substring: string,
  timeoutMs = 200_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const logs = await app.activeVersion?.fetchLogs(
      new Date(Date.now() - 30 * 60 * 1000),
    );
    if (logs?.some((entry) => entry.message.includes(substring))) {
      return;
    }
    await sleep(3_000);
  }
  throw new Error(`Timed out waiting for logs containing '${substring}'`);
}

async function waitForDeletion(
  client: StackMachineClient,
  appId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const app = (await client.getApp({ id: appId })) as DeployAppLike | null;
    if (!app) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for deletion of app '${appId}'`);
}

async function waitForDomainDeletion(
  client: StackMachineClient,
  appId: string,
  aliasId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const app = (await client.getApp({ id: appId })) as DeployAppLike | null;
    if (!app?.domains.find((item) => item.id === aliasId)) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for deletion of domain '${aliasId}'`);
}

async function addDomain(
  env: TestEnv,
  app: DeployAppLike,
): Promise<{ alias: AppAliasLike; domainName: string }> {
  const zone = `${crypto.randomUUID().replace(/-/g, "")}.com`;
  const domainName = `www.${zone}`;

  await env.runWasmerCommand({
    args: ["domain", "register", zone],
  });

  const alias = await app.upsertDomain(domainName);
  expect(alias.expectedDnsRecords.length).toBeGreaterThan(0);
  return { alias, domainName };
}

async function waitForDomainPresent(
  client: StackMachineClient,
  appId: string,
  aliasId: string,
  timeoutMs = 60_000,
): Promise<DeployAppLike> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const app = (await client.getApp({ id: appId })) as DeployAppLike | null;
    if (app?.domains.find((item) => item.id === aliasId)) {
      return app;
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for domain '${aliasId}' to be attached`);
}

describe("stackmachine sdk", () => {
  const cleanupAppIds: string[] = [];

  afterEach(async () => {
    const env = TestEnv.fromEnv();
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

  test("deployFromFiles example", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();
    const app = await deployInlinePhpApp(
      client,
      env,
      "<html><body><h1>Hello World!</h1></body></html>",
    );
    cleanupAppIds.push(app.id);

    expect(app.name).toBeTruthy();
    await expectAppBody(env, app, "Hello World!");
  });

  test("deployFromZip example", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();
    const zip = await createZip({
      "index.php": "<html><body><h1>Hello Zip!</h1></body></html>",
    });
    const uploadUrl = await client.uploadFile(zip);
    const app = await deployUploadedApp(client, env, uploadUrl);
    cleanupAppIds.push(app.id);

    await expectAppBody(env, app, "Hello Zip!");
  });

  test("deployFromZipUrl example", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();
    const uploadUrl = await uploadInlineFiles(client, {
      "index.php": "<html><body><h1>Hello Zip URL!</h1></body></html>",
    });
    const app = await deployUploadedApp(client, env, uploadUrl);
    cleanupAppIds.push(app.id);

    await expectAppBody(env, app, "Hello Zip URL!");
  });

  test("redeployFromFiles example", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();
    const appName = randomAppName();

    const app1 = await deployInlinePhpApp(
      client,
      env,
      "<html><body><h1>Hello World v1!</h1></body></html>",
      appName,
    );
    cleanupAppIds.push(app1.id);
    await expectAppBody(env, app1, "Hello World v1!");

    const app2 = await deployInlinePhpApp(
      client,
      env,
      "<html><body><h1>Hello World v2!</h1></body></html>",
      appName,
      { allowExistingApp: true },
    );

    expect(app2.id).toBe(app1.id);
    await expectAppBody(env, app2, "Hello World v2!");
  });

  test("deployPerishable example", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();
    const app = await deployInlinePhpApp(
      client,
      env,
      "<html><body><h1>This app will perish in 2 hours</h1></body></html>",
      randomAppName(),
      { perishAt: "PT2H" },
    );
    cleanupAppIds.push(app.id);

    expect(app.willPerishAt).not.toBeNull();
    expect(app.willPerishAt!.getTime()).toBeGreaterThan(Date.now());
    await expectAppBody(env, app, "This app will perish in 2 hours");
  });

  test("getAppById example", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();
    const app = await deployInlinePhpApp(
      client,
      env,
      "<html><body><h1>Get By Id</h1></body></html>",
    );
    cleanupAppIds.push(app.id);

    const fetched = (await client.getApp({
      id: app.id,
    })) as DeployAppLike | null;
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(app.id);
    expect(fetched?.url).toBe(app.url);
  });

  test("getAppByName example", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();
    const app = await deployInlinePhpApp(
      client,
      env,
      "<html><body><h1>Get By Name</h1></body></html>",
    );
    cleanupAppIds.push(app.id);

    const fetched = (await client.getApp({
      owner: env.namespace,
      name: app.name,
    })) as DeployAppLike | null;
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(app.id);
  });

  test("getAppLogs example", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();
    const app = await deployInlinePhpApp(
      client,
      env,
      `<?php error_log("hello from stackmachine sdk logs"); echo "ok"; ?>`,
    );
    cleanupAppIds.push(app.id);

    await expectAppBody(env, app, "ok");
    await waitForLogs(app, "hello from stackmachine sdk logs");
  });

  test("addAppDomain example", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();
    const app = await deployInlinePhpApp(
      client,
      env,
      "<html><body><h1>Domain Ready</h1></body></html>",
    );
    cleanupAppIds.push(app.id);

    const { alias, domainName } = await addDomain(env, app);
    const refreshed = await waitForDomainPresent(client, app.id, alias.id);
    expect(
      refreshed.domains.find((item) => item.id === alias.id)?.url,
    ).toContain(domainName);
  });

  test("deleteAppDomain example", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();
    const app = await deployInlinePhpApp(
      client,
      env,
      "<html><body><h1>Delete Domain</h1></body></html>",
    );
    cleanupAppIds.push(app.id);

    const { alias } = await addDomain(env, app);
    await waitForDomainPresent(client, app.id, alias.id);
    await alias.delete();
    await waitForDomainDeletion(client, app.id, alias.id);
  });

  test("deleteApp example", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();
    const app = await deployInlinePhpApp(
      client,
      env,
      "<html><body><h1>Delete Me</h1></body></html>",
    );

    await client.deleteApp({ id: app.id });
    await waitForDeletion(client, app.id);
  });

  test("tiinyBlocked example", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();
    const app = await deployInlinePhpApp(
      client,
      env,
      "<html><body><h1>Hello Tiiny!</h1></body></html>",
    );
    cleanupAppIds.push(app.id);

    await expectAppBody(env, app, "Hello Tiiny!");
  });

  test("deployWordpress example", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stachmachineSdk();
    const appName = randomAppName();

    const build = await client.deployApp({
      appName,
      owner: env.namespace,
      repoUrl: "https://github.com/wordpress/wordpress",
      branch: "6.8.3",
      enableDatabase: true,
      extraData: {
        wordpress: {
          adminEmail: "admin@example.com",
          adminPassword: "%L7:D3Sd{![r",
          adminUsername: "admin",
          language: "en_US",
          siteName: "Gallant Goldberg",
        },
      },
    });

    const appVersion = await build.finish();
    const app = appVersion.app as DeployAppLike;
    cleanupAppIds.push(app.id);

    expect(app.adminUrl).toBeTruthy();
    const response = await env.fetchApp(appFetchTarget(app), "/", {
      forceWait: true,
      noAssertSuccess: true,
    });
    expect([200, 302]).toContain(response.status);
  });
});
