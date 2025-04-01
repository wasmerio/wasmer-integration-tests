import { assertEquals } from "jsr:@std/assert/equals";
import { assertNotEquals } from "jsr:@std/assert/not-equals";
import { assertStringIncludes } from "jsr:@std/assert/string-includes";
import { TestEnv } from "../../src/env.ts";
import { buildPhpApp } from "../../src/index.ts";
import fs from "node:fs";

Deno.test("sql-connectivity", async () => {
  const env = TestEnv.fromEnv();
  const filePath = "./fixtures/php/mysql-check.php";
  const testCode = await fs.promises.readFile(filePath, "utf-8");

  // Validate that DB credentials aren't setup without specifying to have it
  {
    console.log("== Setting up environment without SQL ==");
    const want = "Missing required SQL environment variables";
    const withoutSqlSpec = buildPhpApp(testCode);
    const withoutSqlInfo = await env.deployApp(withoutSqlSpec);
    const res = await env.fetchApp(withoutSqlInfo, "/results");
    const got = await res.text();
    assertStringIncludes(
      got,
      want,
      "Expected environment to NOT include SQL details, as the environment is not specified to include them",
    );
    // Having environment variables set is bad, having the option to connect is worse: would
    // encourage and perhaps enable malicious use
    assertNotEquals(
      got,
      "OK",
      "It appears to be possible to connect to a DB from an unconfigured environment. Very not good!",
    );
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
    assertEquals(got, want);
  }

  // Also test the app version URL to make sure it is configured properly.
  // Reggression test for WAX-373
  {
    const url = withSqlInfo.version.url + "/results";
    const res = await fetch(url);
    const body = await res.text();
    assertEquals(body, want);
  }

  await env.deleteApp(withSqlInfo);
});
