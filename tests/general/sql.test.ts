import { TestEnv } from "../../src/env";
import { buildPhpApp } from "../../src/index";
import * as fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../utils/path";

test.concurrent("sql-connectivity", async () => {
  const env = TestEnv.fromEnv();
  const filePath = path.join(projectRoot, "fixtures", "php", "mysql-check.php");
  const testCode = await fs.promises.readFile(filePath, "utf-8");

  // Validate that DB credentials aren't setup without specifying to have it
  {
    console.log("== Setting up environment without SQL ==");
    const want = "Missing required SQL environment variables";
    const withoutSqlSpec = buildPhpApp(testCode);
    const withoutSqlInfo = await env.deployApp(withoutSqlSpec);
    const res = await env.fetchApp(withoutSqlInfo, "/results");
    const got = await res.text();
    expect(got).toContain(want);
    // Having environment variables set is bad, having the option to connect is worse: would
    // encourage and perhaps enable malicious use
    expect(got).not.toBe("OK");
    await env.deleteApp(withoutSqlInfo);
  }

  // Validate happy-path
  console.log("== Setting up environment with SQL ==");
  const want = "OK";
  const withSqlSpec = buildPhpApp(testCode, {
    debug: true,
    scaling: {
      mode: "single_concurrency",
    },
    capabilities: {
      database: {
        engine: "mysql",
      },
    },
  });
  const withSqlInfo = await env.deployApp(withSqlSpec);

  {
    const res = await env.fetchApp(withSqlInfo, "/results");
    const got = await res.text();
    expect(got).toBe(want);
  }

  // Also test the app version URL to make sure it is configured properly.
  // Reggression test for WAX-373
  {
    const url = withSqlInfo.version.url + "/results";
    const res = await fetch(url);
    const got = await res.text();
    expect(got).toBe(want);
  }

  await env.deleteApp(withSqlInfo);
});
