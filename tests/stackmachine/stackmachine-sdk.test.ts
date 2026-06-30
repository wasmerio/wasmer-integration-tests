import {
  createZip,
  type AppAlias,
  type DeployApp,
  type DeploymentCreateInput,
  type Log,
} from "stackmachine";
import { AppInfo, randomAppName, sleep, TestEnv } from "../../src";
import { generateNeedlesslySecureRandomPassword } from "../../src/security";

jest.setTimeout(600_000);

type StackMachineClient = Awaited<ReturnType<TestEnv["stackmachineSdk"]>>;

function appFetchTarget(app: Pick<DeployApp, "id" | "url">): AppInfo {
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
  return client.files.upload(zip);
}

async function deployUploadedApp(
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

async function deployInlinePhpApp(
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

async function expectAppBody(
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

async function listAppDomains(
  client: StackMachineClient,
  appId: string,
): Promise<AppAlias[]> {
  return (await client.apps.domains.list({ app: appId })).data;
}

async function waitForLogs(
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

async function waitForDeletion(
  client: StackMachineClient,
  appId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [app] = await client.apps.retrieveMany([appId]);
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
    const domains = await listAppDomains(client, appId);
    if (!domains.find((item) => item.id === aliasId)) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for deletion of domain '${aliasId}'`);
}

async function addDomain(
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

async function waitForDomainPresent(
  client: StackMachineClient,
  appId: string,
  aliasId: string,
  timeoutMs = 60_000,
): Promise<AppAlias> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const domains = await listAppDomains(client, appId);
    const alias = domains.find((item) => item.id === aliasId);
    if (alias) {
      return alias;
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for domain '${aliasId}' to be attached`);
}

describe("stackmachine sdk", () => {
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
    const uploadUrl = await client.files.upload(zip);
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

    const fetched = await client.apps.retrieve(app.id);
    expect(fetched.id).toBe(app.id);
    expect(fetched.url).toBe(app.url);
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

    const fetched = await client.apps.retrieveByName(app.name, env.namespace);
    expect(fetched.id).toBe(app.id);
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
    await waitForLogs(client, app, "hello from stackmachine sdk logs");
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

    const { alias, domainName } = await addDomain(client, env, app);
    const refreshed = await waitForDomainPresent(client, app.id, alias.id);
    expect(refreshed.url).toContain(domainName);
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

    const { alias } = await addDomain(client, env, app);
    await waitForDomainPresent(client, app.id, alias.id);
    await client.apps.domains.del(alias.id);
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

    await client.apps.del(app.id);
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
    const client = await env.stackmachineSdk();
    const appName = randomAppName();

    const appVersion = await env.deployStackMachineApp(client, {
      appName,
      owner: env.namespace,
      repoUrl: "https://github.com/wordpress/wordpress",
      branch: "6.8.3",
      enableDatabase: true,
      extraData: {
        wordpress: {
          adminEmail: "admin@example.com",
          adminPassword: generateNeedlesslySecureRandomPassword(),
          adminUsername: "admin",
          language: "en_US",
          siteName: "Gallant Goldberg",
        },
      },
    });
    const app = appVersion.app;
    await env.recordDeployedApp({
      appId: app.id,
      appName,
      appUrl: app.url,
      appPermalink: app.url,
    });
    cleanupAppIds.push(app.id);

    expect(app.adminUrl).toBeTruthy();
    const response = await env.fetchApp(appFetchTarget(app), "/", {
      forceWait: true,
      noAssertSuccess: true,
    });
    expect([200, 302]).toContain(response.status);
  });
});
