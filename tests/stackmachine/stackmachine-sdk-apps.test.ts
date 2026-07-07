import { TestEnv } from "../../src";
import {
  deployInlinePhpApp,
  expectAppBody,
  installSdkAppCleanup,
  waitForDeletion,
  waitForLogs,
} from "../utils/stackmachine-sdk";

jest.setTimeout(600_000);

describe("stackmachine sdk", () => {
  const cleanupAppIds = installSdkAppCleanup();

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
});
