import type { DeployApp } from "stackmachine";

import { randomAppName, TestEnv } from "../../src";
import { generateNeedlesslySecureRandomPassword } from "../../src/security";

export type StackMachineClient = Awaited<
  ReturnType<TestEnv["stackmachineSdk"]>
>;

export interface StackMachineWordpressOptions {
  // WordPress site name, useful for identifying the suite in the dashboard.
  siteName: string;
  // Optional target region name.
  region?: string;
  // Optional origin label recorded for preserved-app debugging.
  origin?: string;
}

/**
 * Deploy the canonical WordPress test app (github.com/wordpress/wordpress at
 * branch 6.8.3, with a managed database) through the StackMachine SDK and
 * record it in the deployed-apps registry.
 */
export async function deployStackMachineWordpress(
  env: TestEnv,
  client: StackMachineClient,
  options: StackMachineWordpressOptions,
): Promise<DeployApp> {
  const appName = randomAppName();
  const appVersion = await env.deployStackMachineApp(client, {
    appName,
    owner: env.namespace,
    repoUrl: "https://github.com/wordpress/wordpress",
    branch: "6.8.3",
    enableDatabase: true,
    ...(options.region ? { region: options.region } : {}),
    extraData: {
      wordpress: {
        adminEmail: "admin@example.com",
        adminPassword: generateNeedlesslySecureRandomPassword(),
        adminUsername: "admin",
        language: "en_US",
        siteName: options.siteName,
      },
    },
  });
  const app = appVersion.app;
  await env.recordDeployedApp({
    appId: app.id,
    appName: app.name,
    appUrl: app.url,
    appPermalink: app.url,
    ...(options.origin ? { origin: options.origin } : {}),
  });
  return app;
}
