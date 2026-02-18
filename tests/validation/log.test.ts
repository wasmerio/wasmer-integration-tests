import * as fs from "fs/promises";
import path from "node:path";
import {
  randomAppName,
  buildPhpApp,
  LogSniff,
  SECOND,
  TestEnv,
} from "../../src";
import { countSubstrings } from "../../src/log";
import { projectRoot } from "../utils/path";

describe("Log tests", () => {
  it("Check fetch is logged on simple logging app", async () => {
    const filePath = path.join(
      projectRoot,
      "fixtures",
      "php",
      "path-logger.php",
    );
    const phpPathLogger = await fs.readFile(filePath, "utf-8");
    const env = TestEnv.fromEnv();
    const appName = randomAppName();

    // Deploy app
    const spec = buildPhpApp(phpPathLogger, { name: appName });
    spec.appYaml.name = appName;
    console.log(JSON.stringify(spec, null, " "));
    const deployedApp = await env.deployApp(spec);
    await env.fetchApp(deployedApp, "/this-is-a-unique-path");

    // Check logs
    const logSniff = new LogSniff(env);
    await logSniff.assertLogsWithin(
      appName,
      "this-is-a-unique-path",
      15 * SECOND,
    );

    // Cleanup
    await env.deleteApp(deployedApp);
  });
});

describe("countSubstrings", () => {
  it("counts single occurrence", () => {
    expect(countSubstrings("hello world", "world")).toBe(1);
  });

  it("counts multiple occurrences", () => {
    expect(countSubstrings("hello hello hello", "hello")).toBe(3);
  });

  it("returns 0 for no occurrences", () => {
    expect(countSubstrings("hello world", "goodbye")).toBe(0);
  });

  it("handles empty string", () => {
    expect(countSubstrings("", "test")).toBe(0);
  });

  it("handles empty substring", () => {
    expect(countSubstrings("hello world", "")).toBe(0);
  });

  it("handles overlapping substrings", () => {
    expect(countSubstrings("aaaaa", "aa")).toBe(4);
  });
});
