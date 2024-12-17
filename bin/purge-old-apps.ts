#!/usr/bin/env -S deno run --allow-all

// Helper script to purge old apps from the test namespace.
// This should be run periodically to keep the namespace clean.

import { TestEnv } from "../test.ts";

// Clean up all old apps created by tests.
async function purgeOldApps(
  env: TestEnv,
  minimumAgeSeconds: number = 60 * 15,
): Promise<{ deleted: number }> {
  let deletedCounter = 0;

  let after: string | null = null;
  while (true) {
    const { apps, lastCursor } = await env.backend.appsInNamespace(
      env.namespace,
      after,
    );

    for (const app of apps) {
      const createdAt = new Date(app.createdAt);
      const ageSeconds = (Date.now() - createdAt.getTime()) / 1000;

      if (app.deleted) {
        // Nothing to do...
      } else if (ageSeconds > minimumAgeSeconds) {
        console.log(`Deleting old app ${app.id} (age: ${ageSeconds}s)`);
        try {
          await env.backend.deleteApp(app.id);
          deletedCounter++;
        } catch (err) {
          if (!err.toString().includes("is already deleted")) {
            throw err;
          }
        }
      } else {
        console.log(`Skipping newer app ${app.id} (age: ${ageSeconds}s)`);
      }
    }
    if (!lastCursor) {
      break;
    }
    after = lastCursor;
  }

  return { deleted: deletedCounter };
}

async function main() {
  const env = TestEnv.fromEnv();
  console.log("Purging old apps...");
  const out = await purgeOldApps(env);
  console.log(`Done. Deleted ${out.deleted} apps.`);
}

main();
