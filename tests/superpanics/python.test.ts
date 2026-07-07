import * as fs from "node:fs";
import path from "node:path";

import { buildPythonApp, TestEnv } from "../../src/index";
import { projectRoot } from "../utils/path";

// Deploys occasionally flake on transient infra errors, so the whole flow is
// retried a bounded number of times. A genuine failure fails all attempts.
const AM_TRIES = 3;

// Test that we can deploy a simple python app
test.concurrent("deploy python app", async () => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= AM_TRIES; attempt++) {
    try {
      const env = TestEnv.fromEnv();
      const filePath = path.join(
        projectRoot,
        "fixtures",
        "python",
        "echo-server.py",
      );
      let testCode = await fs.promises.readFile(filePath, "utf-8");
      testCode = testCode.replaceAll("__TEMPLATE__", `${Math.random()}`);
      const app = buildPythonApp(testCode);
      const appInfo = await env.deployApp(app);

      const uniquePing = Math.random();
      const want = `${uniquePing}`;
      const res = await env.fetchApp(appInfo, want);
      const gotJson = (await res.json()) as { echo: string };
      expect(gotJson.echo).toBe(want);
      await env.deleteApp(appInfo);
      return;
    } catch (e) {
      lastError = e;
      console.error(`Attempt ${attempt}/${AM_TRIES} failed:`, e);
    }
  }
  throw lastError;
});
