import { buildPythonApp, TestEnv } from "../../src/index";
import * as fs from "node:fs";

// Test that we can deploy a simple python app
test.concurrent("deploy python app", async () => {
  const env = TestEnv.fromEnv();
  const filePath = "./fixtures/python/echo-server.py";
  const testCode = await fs.promises.readFile(filePath, "utf-8");
  testCode.replaceAll("__TEMPLATE__", `${Math.random()}`);
  const app = buildPythonApp(testCode);
  const appInfo = await env.deployApp(app);

  const uniquePing = Math.random();
  const want = `${uniquePing}`;
  const res = await env.fetchApp(appInfo, want);
  const gotJson = (await res.json()) as { echo: string };
  const got = gotJson.echo;
  expect(got).toBe(want);
  await env.deleteApp(appInfo);
});
