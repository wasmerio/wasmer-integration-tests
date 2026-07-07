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

// WordPress tests must always track the latest WordPress release. Resolved
// once per jest worker from the canonical wordpress.org version feed; falls
// back to a known-good release only if the feed is unreachable.
const FALLBACK_WORDPRESS_VERSION = "6.8.3";
let latestWordpressVersionPromise: Promise<string> | null = null;

export function latestWordpressVersion(): Promise<string> {
  latestWordpressVersionPromise ??= (async () => {
    try {
      const response = await fetch(
        "https://api.wordpress.org/core/version-check/1.7/",
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as {
        offers?: { current?: string }[];
      };
      const current = data.offers?.[0]?.current;
      if (!current) {
        throw new Error("no offers in version-check response");
      }
      console.info(`Using latest WordPress release: ${current}`);
      return current;
    } catch (error) {
      console.warn(
        `Could not resolve the latest WordPress version (${error}); falling back to ${FALLBACK_WORDPRESS_VERSION}`,
      );
      return FALLBACK_WORDPRESS_VERSION;
    }
  })();
  return latestWordpressVersionPromise;
}

/**
 * Deploy the canonical WordPress test app (github.com/wordpress/wordpress at
 * the latest WordPress release, with a managed database) through the
 * StackMachine SDK and record it in the deployed-apps registry.
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
    branch: await latestWordpressVersion(),
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
