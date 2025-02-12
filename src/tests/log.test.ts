import { assertEquals } from "jsr:@std/assert/equals";
import { AppInfo } from "../backend.ts";
import { TestEnv } from "../env.ts";
import { countSubstrings, LogSniff } from "../log.ts";
import fs from "node:fs";
import { randomAppName } from "../app/index.ts";
import { buildPhpApp } from "../app/php.ts";

const SECOND = 1000;

Deno.test(
  "Log test: Check fetch is logged on simple logging app",
  {},
  async (t) => {
    const filePath = "./src/tests/path-logger.php";
    const phpPathLogger = await fs.promises.readFile(filePath, "utf-8");
    const env = TestEnv.fromEnv();
    const appName = randomAppName();
    let deployedApp: AppInfo;

    await t.step("Deploy app", async () => {
      const spec = buildPhpApp(phpPathLogger, { name: appName });
      spec.appYaml.name = appName;
      console.log(JSON.stringify(spec, null, " "));
      deployedApp = await env.deployApp(spec);
      await env.fetchApp(deployedApp, "/this-is-a-unique-path");
    });

    await t.step("check logs", async () => {
      const logSniff = new LogSniff(env);
      await logSniff.assertLogsWithin(
        appName,
        "this-is-a-unique-path",
        15 * SECOND,
      );
    });

    await t.step("delete app", async () => {
      await env.deleteApp(deployedApp);
    });
  },
);

Deno.test("Unittest: countSubstrings", async (t) => {
  await t.step("counts single occurrence", () => {
    assertEquals(countSubstrings("hello world", "world"), 1);
  });

  await t.step("counts multiple occurrences", () => {
    assertEquals(countSubstrings("hello hello hello", "hello"), 3);
  });

  await t.step("returns 0 for no occurrences", () => {
    assertEquals(countSubstrings("hello world", "goodbye"), 0);
  });

  await t.step("handles empty string", () => {
    assertEquals(countSubstrings("", "test"), 0);
  });

  await t.step("handles empty substring", () => {
    assertEquals(countSubstrings("hello world", ""), 0);
  });

  await t.step("handles overlapping substrings", () => {
    // Hmm.. Not great, not terrible
    assertEquals(countSubstrings("aaaaa", "aa"), 4);
  });
});
