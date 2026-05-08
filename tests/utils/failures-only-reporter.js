import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REGISTRY_PATH = path.join(process.cwd(), ".jest-deployed-apps.jsonl");

function color(code, value) {
  if (process.env.NO_COLOR) {
    return value;
  }
  return `\u001b[${code}m${value}\u001b[0m`;
}

function readDeployedAppsForTestFile(testFilePath) {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return [];
  }

  const normalizedTestPath = path.normalize(testFilePath);
  const records = fs
    .readFileSync(REGISTRY_PATH, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((record) => record !== null)
    .filter((record) => {
      if (!record.testPath) {
        return false;
      }
      return path.normalize(record.testPath) === normalizedTestPath;
    });

  const byAppId = new Map();
  for (const record of records) {
    byAppId.set(record.appId, record);
  }
  return [...byAppId.values()];
}

function formatAppContext(testFilePath) {
  const apps = readDeployedAppsForTestFile(testFilePath);
  if (apps.length === 0) {
    return [
      color("33", "\nNo deployed app records found for failing test file."),
      `Registry: ${REGISTRY_PATH}`,
      "",
    ].join("\n");
  }

  const lines = [
    "",
    color("1", color("36", "Deployed apps for failing test file")),
    color("36", "────────────────────────────────────"),
    `Test file: ${testFilePath}`,
    `Tip: rerun with ${color("33", "KEEP_APPS=1")} to skip deletion and inspect apps after failure.`,
    "",
  ];

  for (const app of apps) {
    lines.push(
      color("36", "┌────────────────────────────────────────────────────────"),
      `${color("36", "│")} ${color("2", "origin        ")} ${app.origin ?? app.testName ?? "unknown"}`,
      `${color("36", "│")} ${color("2", "app id        ")} ${color("33", app.appId)}`,
      `${color("36", "│")} ${color("2", "app name      ")} ${app.namespace}/${app.appName}`,
      `${color("36", "│")} ${color("2", "app url       ")} ${color("32", app.appUrl)}`,
      `${color("36", "│")} ${color("2", "permalink     ")} ${color("32", app.appPermalink)}`,
      `${color("36", "│")} ${color("2", "dashboard     ")} ${color("32", app.appDashboard)}`,
      `${color("36", "│")} ${color("2", "app dir       ")} ${app.appDir}`,
      color("36", "└────────────────────────────────────────────────────────"),
      "",
    );
  }

  return lines.join("\n");
}

class FailuresOnlyReporter {
  onTestResult(_testContext, testResult) {
    const hasFailures =
      testResult.numFailingTests > 0 ||
      testResult.numRuntimeErrorTestSuites > 0 ||
      testResult.testExecError != null;

    const buffer = testResult.console ?? [];

    if (hasFailures) {
      for (const entry of buffer) {
        const log = globalThis.console?.[entry.type] ?? globalThis.console?.log;
        log(entry.message);
      }
      process.stderr.write(`${formatAppContext(testResult.testFilePath)}\n`);
    }

    testResult.console = undefined;
  }
}

export default FailuresOnlyReporter;
