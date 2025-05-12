import { assertStringIncludes } from "jsr:@std/assert";

import { buildPythonApp, TestEnv } from "../../src/index.ts";
import fs from "node:fs";

// Test that we can deploy a simple python app
Deno.test("deploy python app", {
  sanitizeResources: false,
}, async () => {
  const env = TestEnv.fromEnv();
  const filePath = "./fixtures/python/echo-server.py";
  const testCode = await fs.promises.readFile(filePath, "utf-8");
  testCode.replaceAll("__TEMPLATE__", `${Math.random()}`);
  const app = buildPythonApp(testCode);
  const appInfo = await env.deployApp(app);

  const uniquePing = Math.random();
  const res = await env.fetchApp(appInfo, `${uniquePing}`);
  const gotJson = await res.json();
  assertStringIncludes(
    gotJson.echo,
    `${uniquePing}`,
    `Expected ${uniquePing} from echo server`,
  );
  await env.deleteApp(appInfo);
});
