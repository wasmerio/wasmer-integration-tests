import { TestEnv } from "../../src";
import {
  addDomain,
  deployInlinePhpApp,
  installSdkAppCleanup,
  waitForDomainDeletion,
  waitForDomainPresent,
} from "../utils/stackmachine-sdk";

jest.setTimeout(600_000);

describe("stackmachine sdk", () => {
  const cleanupAppIds = installSdkAppCleanup();

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
});
