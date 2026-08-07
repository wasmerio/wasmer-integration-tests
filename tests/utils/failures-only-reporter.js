// Failure-focused jest reporter.
//
// Output layout is bottom-up: per-test failure context (console replay,
// compact app cards, log snippets) prints as suites finish, and the run
// ends with a summary of every failed test plus a ready-to-paste hivemind
// investigation prompt — GitHub's log viewer auto-scrolls to the bottom,
// so the bottom must carry the highest-value content.
//
// Failures are classified against known-issues.jsonc: KNOWN issues link
// their Linear ticket and skip log output; UNTRACKED failures get a log
// snippet (full logs only with VERBOSE=true — deep investigation is meant
// to happen agentically, not by scrolling CI logs).

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
const LOG_SNIPPET_MAX_CHARS = 2_000;

function color(code, value) {
  if (process.env.NO_COLOR) {
    return value;
  }
  return `\u001b[${code}m${value}\u001b[0m`;
}

// --- known-issues registry ------------------------------------------------

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

// --- deployed-app registry ------------------------------------------------

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

// --- console replay -------------------------------------------------------

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

// --- app logs -------------------------------------------------------------

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

// Tail snippet — the primary investigation is agentic (artifacts + hivemind
// prompt below), the inline log only orients the reader.
function logSnippet(text) {
  if (isVerboseEnabled() || text.length <= LOG_SNIPPET_MAX_CHARS) {
    return text;
  }
  const tail = text.slice(-LOG_SNIPPET_MAX_CHARS);
  const skipped = text.length - tail.length;
  return `… (${skipped} earlier characters snipped; VERBOSE=true for full logs)\n${tail}`;
}

// --- failure blocks -------------------------------------------------------

function knownIssueLines(known, indent) {
  return [
    color("33", `${indent}⚠ KNOWN ISSUE ${known.ticket} — ${known.url}`),
    ...(known.note ? [`${indent}  ${known.note}`] : []),
  ];
}

function untrackedLines(indent) {
  return [
    color("31", `${indent}🔥 UNTRACKED — no Linear ticket on record.`),
    `${indent}  If this is a product bug: linear-ticket + file-known-issue skills.`,
  ];
}

function appCardLines(app, known, indent) {
  const lines = [
    `${indent}${color("36", "app")} ${app.namespace}/${app.appName} (${color("33", app.appId)})`,
    `${indent}    url        ${color("32", app.appUrl)}`,
    `${indent}    dashboard  ${color("32", app.appDashboard)}`,
  ];
  const envRegistry = process.env.WASMER_REGISTRY;
  if (app.registry && app.registry !== envRegistry) {
    lines.push(`${indent}    registry   ${app.registry}`);
  }
  if (known) {
    lines.push(
      `${indent}    logs       wasmer app logs ${app.namespace}/${app.appName}`,
    );
  } else {
    const snippet = logSnippet(fetchAppLogs(app));
    lines.push(
      `${indent}    ${color("2", "logs ────────────────────────────")}`,
      ...snippet
        .split("\n")
        .map((line) => `${indent}    ${color("2", "│")} ${line}`),
    );
  }
  return lines;
}

function failureContextLines(testResult) {
  const lines = [];
  const failingNames = [...getFailingTestNames(testResult)];
  if (failingNames.length === 0 && !testResult.testExecError) {
    return lines;
  }

  const allApps = readDeployedAppsForTestFile(testResult.testFilePath);
  const usedAppIds = new Set();

  lines.push(
    "",
    color("36", "──────────────────────────────────────────────────────────"),
    color("1", color("36", `Failure context — ${testResult.testFilePath}`)),
  );
  if (allApps.length > 0) {
    lines.push(
      color(
        "2",
        `Apps preserved for debugging (${color("33", "KEEP_APPS=1")} to also keep passing-test apps)`,
      ),
    );
  }

  for (const fullName of failingNames) {
    const known = findKnownIssue(testResult.testFilePath, fullName);
    lines.push("", color("31", `✕ ${fullName}`));
    lines.push(
      ...(known ? knownIssueLines(known, "  ") : untrackedLines("  ")),
    );
    const apps = allApps.filter((app) =>
      matchesFailingTest(app, new Set([fullName])),
    );
    for (const app of apps) {
      usedAppIds.add(app.appId);
      lines.push(...appCardLines(app, known, "  "));
    }
  }

  if (testResult.testExecError) {
    const known = findKnownIssue(testResult.testFilePath, null);
    lines.push("", color("31", "✕ suite failed to run"));
    lines.push(
      ...(known ? knownIssueLines(known, "  ") : untrackedLines("  ")),
    );
  }

  const leftover = allApps.filter((app) => !usedAppIds.has(app.appId));
  if (leftover.length > 0) {
    lines.push("", color("2", "other apps deployed by this file:"));
    for (const app of leftover) {
      lines.push(
        ...appCardLines(
          app,
          findKnownIssue(testResult.testFilePath, null),
          "  ",
        ),
      );
    }
  }

  return lines;
}

function fixedKnownIssueLines(testResult) {
  const lines = [];
  for (const result of testResult.testResults ?? []) {
    if (result.status !== "passed") {
      continue;
    }
    const fullName = [...result.ancestorTitles, result.title].join(" ");
    const known = findKnownIssue(testResult.testFilePath, fullName);
    if (known) {
      lines.push(
        color(
          "32",
          `✔ ${known.ticket} is listed in known-issues.jsonc but "${fullName}" passed — the issue may be fixed; consider removing the entry`,
        ),
      );
    }
  }
  return lines;
}

// --- end-of-run summary ---------------------------------------------------

function collectFailures(results) {
  const failures = [];
  for (const suite of results.testResults ?? []) {
    const file = path.relative(process.cwd(), suite.testFilePath);
    if (suite.testExecError) {
      failures.push({
        file,
        fullName: `suite failed to run (${file})`,
        known: findKnownIssue(suite.testFilePath, null),
      });
    }
    for (const result of suite.testResults ?? []) {
      if (result.status !== "failed") {
        continue;
      }
      const fullName = [...result.ancestorTitles, result.title].join(" ");
      failures.push({
        file,
        fullName,
        known: findKnownIssue(suite.testFilePath, fullName),
      });
    }
  }
  return failures;
}

function hivemindPrompt(failures) {
  const runUrl =
    process.env.GITHUB_ACTIONS && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  const source = runUrl
    ? `CI run ${runUrl} (test-run-* artifacts carry jest-output.log, .jest-run-summary.jsonl and .jest-deployed-apps.jsonl per suite)`
    : `local run in ${process.cwd()} (.jest-run-summary.jsonl, .jest-deployed-apps.jsonl)`;
  const list = failures
    .map((failure) =>
      failure.known
        ? `- [KNOWN ${failure.known.ticket} ${failure.known.url}] ${failure.fullName} (${failure.file})`
        : `- [UNTRACKED] ${failure.fullName} (${failure.file})`,
    )
    .join("\n");
  return [
    "Investigate these wasmer integration test failures (load your integration-test-failure skill).",
    `Source: ${source}`,
    "Failing tests:",
    list,
    "Fetch the run artifacts and root-cause each UNTRACKED failure first.",
    "For confirmed product bugs: file a Linear ticket (linear-ticket format) and register the test in wasmer-integration-tests known-issues.jsonc per the file-known-issue skill.",
    "For KNOWN failures, only verify the ticket still matches the observed behavior.",
  ].join("\n");
}

function runSummaryLines(failures) {
  const known = failures.filter((failure) => failure.known);
  const untracked = failures.filter((failure) => !failure.known);
  const lines = [
    "",
    color("1", "════════════════════════════════════════════════════════════"),
    color(
      "1",
      `FAILED TESTS — ${failures.length} total (${untracked.length} untracked, ${known.length} known)`,
    ),
  ];
  if (untracked.length > 0) {
    lines.push(color("31", "🔥 UNTRACKED:"));
    for (const failure of untracked) {
      lines.push(`  ✕ ${failure.fullName} — ${failure.file}`);
    }
  }
  if (known.length > 0) {
    lines.push(color("33", "⚠ KNOWN:"));
    for (const failure of known) {
      lines.push(
        `  ✕ ${failure.fullName} — ${color("33", failure.known.ticket)} ${failure.known.url}`,
      );
    }
  }
  lines.push(
    "",
    color(
      "1",
      color(
        "36",
        "Investigate agentically — paste this into your hivemind agent:",
      ),
    ),
    color("36", "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄"),
    hivemindPrompt(failures),
    color("36", "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄"),
    "",
  );
  return lines;
}

// --- reporter -------------------------------------------------------------

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
      const contextLines = failureContextLines(testResult);
      if (contextLines.length > 0) {
        process.stderr.write(`${contextLines.join("\n")}\n`);
      }
    }

    const fixedLines = fixedKnownIssueLines(testResult);
    if (fixedLines.length > 0) {
      process.stderr.write(`\n${fixedLines.join("\n")}\n`);
    }

    testResult.console = undefined;
  }

  // Appends one machine-readable record per jest invocation for CI (Barmin)
  // to aggregate, then prints the failed-test summary and the hivemind
  // investigation prompt — last, because GitHub's log viewer lands at the
  // bottom of a failed job.
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

    try {
      const failures = collectFailures(results);
      if (failures.length > 0) {
        process.stderr.write(`${runSummaryLines(failures).join("\n")}\n`);
      }
    } catch (error) {
      process.stderr.write(
        `failures-only-reporter: failed to print run summary: ${error}\n`,
      );
    }
  }
}

export default FailuresOnlyReporter;
