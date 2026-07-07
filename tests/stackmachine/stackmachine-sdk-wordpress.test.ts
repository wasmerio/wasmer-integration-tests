import { TestEnv } from "../../src";
import {
  appFetchTarget,
  installSdkAppCleanup,
} from "../utils/stackmachine-sdk";
import { deployStackMachineWordpress } from "../utils/stackmachine-wordpress";

jest.setTimeout(600_000);

describe("stackmachine sdk", () => {
  const cleanupAppIds = installSdkAppCleanup();

  test("deployWordpress example", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();
    const app = await deployStackMachineWordpress(env, client, {
      siteName: "Gallant Goldberg",
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
