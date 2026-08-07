import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function isVerboseEnabled() {
  return /^(1|true|yes|on)$/i.test(process.env.VERBOSE ?? "");
}

const REGISTRY_PATH = path.join(process.cwd(), ".jest-deployed-apps.jsonl");
const KNOWN_ISSUES_PATH = path.join(process.cwd(), "known-issues.jsonc");
const RUN_SUMMARY_PATH = path.join(process.cwd(), ".jest-run-summary.jsonl");
const LINEAR_ISSUE_URL_BASE = "https://linear.app/wasmer/issue";
const CONSOLE_TEST_MARKER_RE = /^\[\[wasmer-test:([^\]]+)\]\]\s?/;

function color(code, value) {
  if (process.env.NO_COLOR) {
    return value;
  }
  return `\u001b[${code}m${value}\u001b[0m`;
}

let knownIssuesCache;
function loadKnownIssues() {
  if (knownIssuesCache !== undefined) {
    return knownIssuesCache;
  }
  knownIssuesCache = [];
  try {
    if (fs.existsSync(KNOWN_ISSUES_PATH)) {
      // Full-line comments only; trailing comments would corrupt values
      // containing "//" (URLs). Prettier formats .jsonc with trailing
      // commas, which JSON.parse rejects — strip those too.
      const raw = fs
        .readFileSync(KNOWN_ISSUES_PATH, "utf-8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n")
        .replace(/,(\s*[}\]])/g, "$1");
      knownIssuesCache = Object.entries(JSON.parse(raw)).map(([key, value]) => {
        const separator = key.indexOf("::");
        const file = separator === -1 ? key : key.slice(0, separator);
        const name = separator === -1 ? null : key.slice(separator + 2);
        return {
          file: path.normalize(file),
          name,
          ticket: value.ticket,
          note: value.note ?? null,
          url: `${LINEAR_ISSUE_URL_BASE}/${value.ticket}`,
        };
      });
    }
  } catch (error) {
    process.stderr.write(
      `failures-only-reporter: could not parse ${KNOWN_ISSUES_PATH}: ${error}\n`,
    );
  }
  return knownIssuesCache;
}

// fullName === null matches only file-level entries (suite load errors).
function findKnownIssue(testFilePath, fullName) {
  const relativePath = path.normalize(
    path.relative(process.cwd(), testFilePath),
  );
  for (const entry of loadKnownIssues()) {
    if (entry.file !== relativePath) {
      continue;
    }
    if (entry.name === null) {
      return entry;
    }
    if (
      fullName !== null &&
      (fullName === entry.name || fullName.startsWith(`${entry.name} `))
    ) {
      return entry;
    }
  }
  return null;
}

function knownIssueSummaryFields(entry) {
  return {
    ticket: entry.ticket,
    url: entry.url,
    ...(entry.note ? { note: entry.note } : {}),
  };
}

function knownIssueBannerLines(testResult) {
  const lines = [];
  for (const result of testResult.testResults ?? []) {
    const fullName = [...result.ancestorTitles, result.title].join(" ");
    const known = findKnownIssue(testResult.testFilePath, fullName);
    if (result.status === "failed") {
      if (known) {
        lines.push(
          color("33", `⚠ KNOWN ISSUE ${known.ticket} — ${fullName}`),
          `  ${known.url}`,
          ...(known.note ? [`  ${known.note}`] : []),
        );
      } else {
        lines.push(
          color("31", `🔥 UNTRACKED FAILURE — ${fullName}`),
          "  No Linear ticket on record. If this is a product bug, file one (linear-ticket skill) and register it in known-issues.jsonc (file-known-issue skill).",
        );
      }
    } else if (result.status === "passed" && known) {
      lines.push(
        color(
          "32",
          `✔ ${known.ticket} is listed in known-issues.jsonc but "${fullName}" passed — the issue may be fixed; consider removing the entry`,
        ),
      );
    }
  }
  if (testResult.testExecError) {
    const known = findKnownIssue(testResult.testFilePath, null);
    if (known) {
      lines.push(
        color("33", `⚠ KNOWN ISSUE ${known.ticket} — suite failed to run`),
        `  ${known.url}`,
      );
    } else {
      lines.push(
        color("31", "🔥 UNTRACKED SUITE FAILURE — suite failed to run"),
        "  No Linear ticket on record for this file in known-issues.jsonc.",
      );
    }
  }
  return lines;
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
      [...failingTestNames].some(
        (testName) =>
          testName.endsWith(candidate) ||
          // Suite-level records (e.g. apps deployed in beforeAll, tagged with
          // the describe title) have no per-test name, so match any failing
          // test whose full name is nested under that prefix.
          testName.startsWith(`${candidate} `),
      ),
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

    const bannerLines = knownIssueBannerLines(testResult);
    if (bannerLines.length > 0) {
      process.stderr.write(`\n${bannerLines.join("\n")}\n`);
    }

    testResult.console = undefined;
  }

  // Appends one machine-readable record per jest invocation for CI (Barmin)
  // to aggregate. CI workspaces are fresh; local files may accumulate records
  // from earlier runs — each carries its own timestamps.
  onRunComplete(_contexts, results) {
    try {
      const record = {
        startedAt: new Date(results.startTime).toISOString(),
        completedAt: new Date().toISOString(),
        numTotalTests: results.numTotalTests,
        numPassedTests: results.numPassedTests,
        numFailedTests: results.numFailedTests,
        numPendingTests: results.numPendingTests,
        suiteErrors: [],
        tests: [],
      };
      for (const suite of results.testResults ?? []) {
        const file = path.relative(process.cwd(), suite.testFilePath);
        if (suite.testExecError) {
          const known = findKnownIssue(suite.testFilePath, null);
          record.suiteErrors.push({
            file,
            message: String(
              suite.testExecError.message ?? suite.testExecError,
            ).slice(0, 2000),
            ...(known ? { knownIssue: knownIssueSummaryFields(known) } : {}),
          });
        }
        for (const result of suite.testResults ?? []) {
          const fullName = [...result.ancestorTitles, result.title].join(" ");
          const known = findKnownIssue(suite.testFilePath, fullName);
          record.tests.push({
            file,
            fullName,
            status: result.status,
            durationMs: result.duration ?? null,
            ...(known ? { knownIssue: knownIssueSummaryFields(known) } : {}),
          });
        }
      }
      fs.appendFileSync(RUN_SUMMARY_PATH, `${JSON.stringify(record)}\n`);
    } catch (error) {
      process.stderr.write(
        `failures-only-reporter: failed to write ${RUN_SUMMARY_PATH}: ${error}\n`,
      );
    }
  }
}

export default FailuresOnlyReporter;
