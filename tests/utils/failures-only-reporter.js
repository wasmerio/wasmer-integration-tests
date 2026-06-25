import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function isVerboseEnabled() {
  return /^(1|true|yes|on)$/i.test(process.env.VERBOSE ?? "");
}

const REGISTRY_PATH = path.join(process.cwd(), ".jest-deployed-apps.jsonl");
const CONSOLE_TEST_MARKER_RE = /^\[\[wasmer-test:([^\]]+)\]\]\s?/;

function color(code, value) {
  if (process.env.NO_COLOR) {
    return value;
  }
  return `\u001b[${code}m${value}\u001b[0m`;
}

function matchesFailingTest(record, failingTestNames) {
  if (!failingTestNames) {
    return true;
  }

  const candidates = [record.testName, record.origin].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  return candidates.some(
    (candidate) =>
      failingTestNames.has(candidate) ||
      [...failingTestNames].some((testName) => testName.endsWith(candidate)),
  );
}

function readDeployedAppsForTestFile(testFilePath, failingTestNames = null) {
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
      if (path.normalize(record.testPath) !== normalizedTestPath) {
        return false;
      }
      return matchesFailingTest(record, failingTestNames);
    });

  const byAppId = new Map();
  for (const record of records) {
    byAppId.set(record.appId, record);
  }
  return [...byAppId.values()];
}

function readAppsForFailure(testFilePath, failingTestNames) {
  return readDeployedAppsForTestFile(testFilePath, failingTestNames);
}

function formatAppContext(testFilePath, failingTestNames) {
  const apps = readAppsForFailure(testFilePath, failingTestNames);
  if (apps.length === 0) {
    return [
      color("33", "\nNo deployed app records found for failing test(s)."),
      `Registry: ${REGISTRY_PATH}`,
      "",
    ].join("\n");
  }

  const lines = [
    "",
    color("1", color("36", "Deployed apps for failing test(s)")),
    color("36", "────────────────────────────────────"),
    `Test file: ${testFilePath}`,
    `Failing-test apps are preserved by default. Use ${color("33", "KEEP_APPS=1")} to preserve apps for passing tests too.`,
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
      `${color("36", "│")} ${color("2", "registry      ")} ${app.registry ?? process.env.WASMER_REGISTRY ?? "default"}`,
      `${color("36", "│")} ${color("2", "app dir       ")} ${app.appDir}`,
      color("36", "└────────────────────────────────────────────────────────"),
      "",
    );
  }

  return lines.join("\n");
}

function getFailingTestNames(testResult) {
  const names = new Set();
  for (const result of testResult.testResults ?? []) {
    if (result.status !== "failed") {
      continue;
    }
    names.add([...result.ancestorTitles, result.title].join(" "));
  }
  return names;
}

function parseConsoleTestMarker(message) {
  const match = message.match(CONSOLE_TEST_MARKER_RE);
  if (!match) {
    return { testName: null, message };
  }

  let testName = match[1];
  try {
    testName = decodeURIComponent(testName);
  } catch {
    // Keep the encoded value if the marker is malformed.
  }

  return {
    testName,
    message: message.slice(match[0].length),
  };
}

function consoleEntryForFailingTests(entry, failingTestNames) {
  const parsed = parseConsoleTestMarker(entry.message);
  if (
    parsed.testName &&
    failingTestNames &&
    !matchesFailingTest({ testName: parsed.testName }, failingTestNames)
  ) {
    return null;
  }
  return { ...entry, message: parsed.message };
}

function truncate(value) {
  const maxLength = isVerboseEnabled()
    ? Number.POSITIVE_INFINITY
    : Number(process.env.MAX_APP_LOG_PRINT_LENGTH ?? 20_000);
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n... and ${value.length - maxLength} more characters (rerun with VERBOSE=true to see all app logs)`;
}

function fetchAppLogs(app) {
  const wasmerBinary = process.env.WASMER_PATH ?? "wasmer";
  const env = { ...process.env };
  if (app.registry) {
    env.WASMER_REGISTRY = app.registry;
  }

  const appIdent = `${app.namespace}/${app.appName}`;
  const result = spawnSync(wasmerBinary, ["app", "logs", appIdent], {
    env,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    return `Failed to run '${wasmerBinary} app logs ${appIdent}': ${result.error.message}`;
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    return [
      `Failed to fetch logs with '${wasmerBinary} app logs ${appIdent}' (exit ${result.status})`,
      stderr.trim() ? `stderr:\n${stderr}` : null,
      stdout.trim() ? `stdout:\n${stdout}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return stdout.trim() ? stdout : "No app logs returned.";
}

function formatAppLogs(testFilePath, failingTestNames) {
  const apps = readAppsForFailure(testFilePath, failingTestNames);
  if (apps.length === 0) {
    return "";
  }

  const lines = [
    "",
    color("1", color("36", "App logs for failing test(s)")),
    color("36", "────────────────────────────"),
  ];

  for (const app of apps) {
    lines.push(
      "",
      color("36", `▶ ${app.namespace}/${app.appName} (${app.appId})`),
      truncate(fetchAppLogs(app)),
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
      const failingTestNames = getFailingTestNames(testResult);
      const appTestNames = failingTestNames.size > 0 ? failingTestNames : null;
      for (const entry of buffer) {
        const filteredEntry = consoleEntryForFailingTests(entry, appTestNames);
        if (!filteredEntry) {
          continue;
        }
        const log =
          globalThis.console?.[filteredEntry.type] ?? globalThis.console?.log;
        log(filteredEntry.message);
      }
      process.stderr.write(
        `${formatAppContext(testResult.testFilePath, appTestNames)}\n`,
      );
      process.stderr.write(
        `${formatAppLogs(testResult.testFilePath, appTestNames)}\n`,
      );
    }

    testResult.console = undefined;
  }
}

export default FailuresOnlyReporter;
