import { randomAppName, TestEnv } from "../../src";
import {
  deployInlinePhpApp,
  deployUploadedApp,
  expectAppBody,
  installSdkAppCleanup,
  uploadInlineFiles,
} from "../utils/stackmachine-sdk";
import { createZip } from "stackmachine";

jest.setTimeout(600_000);

describe("stackmachine sdk", () => {
  const cleanupAppIds = installSdkAppCleanup();

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
});
