import { z } from "zod";

import { randomAppName, TestEnv } from "../../src";
import { generateNeedlesslySecureRandomPassword } from "../../src/security";
import { validateWordpressIsLive } from "../../src/wordpress";

jest.setTimeout(1_800_000);

type StackMachineClient = Awaited<ReturnType<TestEnv["stackmachineSdk"]>>;

const deployAppLikeSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  adminUrl: z.string().optional(),
});

type DeployAppLike = z.infer<typeof deployAppLikeSchema>;

const stackMachineWordpressDeployInputSchema = z.object({
  appName: z.string(),
  owner: z.string(),
  repoUrl: z.literal("https://github.com/wordpress/wordpress"),
  branch: z.literal("6.8.3"),
  enableDatabase: z.literal(true),
  region: z.string(),
  extraData: z.object({
    wordpress: z.object({
      adminEmail: z.string(),
      adminPassword: z.string(),
      adminUsername: z.string(),
      language: z.string(),
      siteName: z.string(),
    }),
  }),
});

type StackMachineWordpressDeployInput = z.infer<
  typeof stackMachineWordpressDeployInputSchema
>;

async function deployStackMachineWordpressToRegion(
  env: TestEnv,
  client: StackMachineClient,
  regionName: string,
): Promise<DeployAppLike> {
  const appName = randomAppName();
  const input: StackMachineWordpressDeployInput =
    stackMachineWordpressDeployInputSchema.parse({
      appName,
      owner: env.namespace,
      repoUrl: "https://github.com/wordpress/wordpress",
      branch: "6.8.3",
      enableDatabase: true,
      region: regionName,
      extraData: {
        wordpress: {
          adminEmail: "admin@example.com",
          adminPassword: generateNeedlesslySecureRandomPassword(),
          adminUsername: "admin",
          language: "en_US",
          siteName: `WordPress region integration test ${regionName}`,
        },
      },
    });
  const build = await client.deployApp(input);

  const appVersion = await build.finish();
  const app = deployAppLikeSchema.parse(appVersion.app);
  await env.recordDeployedApp({
    appId: app.id,
    appName: app.name,
    appUrl: app.url,
    appPermalink: app.url,
  });
  return app;
}

describe("stackmachine wordpress regions", () => {
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

  test("deploys WordPress to every active database-capable region", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();
    const regions = await env.backend.getAllAppRegions({
      active: true,
      supportsDatabases: true,
    });
    const regionNames = regions.map((region) => region.name);

    expect(regionNames.length).toBeGreaterThan(0);
    console.info(
      `Deploying StackMachine WordPress app to regions: ${regionNames.join(", ")}`,
    );

    const deployedRegions: string[] = [];
    for (const regionName of regionNames) {
      let app: DeployAppLike;
      try {
        app = await deployStackMachineWordpressToRegion(env, client, regionName);
      } catch (error) {
        throw new Error(
          `Failed to deploy StackMachine WordPress app to region '${regionName}'`,
          { cause: error },
        );
      }

      cleanupAppIds.push(app.id);
      try {
        expect(app.adminUrl).toBeTruthy();
        await validateWordpressIsLive(env, app.url);
      } catch (error) {
        throw new Error(
          `StackMachine WordPress app '${app.id}' did not validate in region '${regionName}' (${app.url})`,
          { cause: error },
        );
      }
      deployedRegions.push(regionName);
    }

    expect(deployedRegions).toEqual(regionNames);
  });
});
