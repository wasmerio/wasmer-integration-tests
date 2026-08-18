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
const ENV_BY_HOST = {
  "wasmer.wtf": "dev",
  "wasmer.fun": "bugt",
  "wasmer.io": "prod",
};
const KNOWN_ENVS = new Set(["dev", "bugt", "prod", "local"]);
const CONSOLE_TEST_MARKER_RE = /^\[\[wasmer-test:([^\]]+)\]\]\s?/;
const LOG_SNIPPET_MAX_CHARS = 2_000;

function color(code, value) {
  if (process.env.NO_COLOR) {
    return value;
  }
  return `\u001b[${code}m${value}\u001b[0m`;
}

// --- environment ----------------------------------------------------------

// Entries in known-issues.jsonc may scope themselves to the environments
// where the bug reproduces. Anything that is not a known registry (local
// platform, ad-hoc stack) resolves to "local" and matches every scoped
// entry: a local run keeps behaving as it did before scoping existed.

let currentEnvironmentCache;
function currentEnvironment() {
  if (currentEnvironmentCache !== undefined) {
    return currentEnvironmentCache;
  }
  const raw = process.env.WASMER_REGISTRY ?? process.env.TESTED_REGISTRY ?? "";
  const host = raw
    .replace(/^[a-z]+:\/\//i, "")
    .split("/")[0]
    .replace(/^registry\./i, "")
    .toLowerCase();
  // Unset means the suite defaults to dev (src/env.ts).
  currentEnvironmentCache =
    host === "" ? "dev" : (ENV_BY_HOST[host] ?? "local");
  return currentEnvironmentCache;
}

// An entry without "envs" applies everywhere. A scoped entry applies to the
// environments it lists, plus any unmapped registry (see above).
function appliesToCurrentEnvironment(entry) {
  if (!entry?.envs) {
    return true;
  }
  const env = currentEnvironment();
  return env === "local" || entry.envs.includes(env);
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
          envs: parseEnvs(value.envs, key),
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

// An unusable "envs" value degrades to an unscoped entry — a typo must not
// silently turn a tracked failure into an UNTRACKED one — but it says so.
function parseEnvs(value, key) {
  if (value === undefined || value === null) {
    return null;
  }
  const values = Array.isArray(value) ? value : [value];
  const valid = values.filter((env) => KNOWN_ENVS.has(env));
  const invalid = values.filter((env) => !KNOWN_ENVS.has(env));
  if (invalid.length > 0) {
    process.stderr.write(
      `failures-only-reporter: ignoring unknown envs ${JSON.stringify(invalid)} ` +
        `on "${key}" (valid: ${[...KNOWN_ENVS].join(", ")})\n`,
    );
  }
  return valid.length > 0 ? valid : null;
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

// knownIssue means "tracked here"; knownIssueOutOfScope records the entry
// that exists for other environments so Barmin can cross-reference it.
function summaryIssueFields(classified) {
  if (classified.known) {
    return { knownIssue: knownIssueSummaryFields(classified.known) };
  }
  if (classified.outOfScope) {
    return {
      knownIssueOutOfScope: knownIssueSummaryFields(classified.outOfScope),
    };
  }
  return {};
}

function knownIssueSummaryFields(entry) {
  return {
    ticket: entry.ticket,
    url: entry.url,
    ...(entry.envs ? { envs: entry.envs } : {}),
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

// The test is registered, but not for the environment under test: a tracked
// bug reaching a new environment is an event, so it stays loud and links the
// entry that already exists instead of inviting a duplicate ticket.
function outOfScopeLines(entry, indent) {
  return [
    color(
      "31",
      `${indent}🔥 UNTRACKED — no Linear ticket on record for this environment.`,
    ),
    `${indent}  ${entry.ticket} is registered for ${entry.envs.join(", ")} — this is ${currentEnvironment()}.`,
    `${indent}  Scope change, not a new bug: comment on ${entry.ticket} and widen`,
    `${indent}  the envs list, or file a separate ticket if the shape differs.`,
    `${indent}  ${entry.url}`,
  ];
}

// KNOWN only counts in the environments the entry claims; everywhere else the
// entry is reported as an out-of-scope sighting.
function classifyFailure(testFilePath, fullName) {
  const entry = findKnownIssue(testFilePath, fullName);
  if (!entry) {
    return { known: null, outOfScope: null };
  }
  return appliesToCurrentEnvironment(entry)
    ? { known: entry, outOfScope: null }
    : { known: null, outOfScope: entry };
}

function classifiedFailureLines(classified, indent) {
  if (classified.known) {
    return knownIssueLines(classified.known, indent);
  }
  if (classified.outOfScope) {
    return outOfScopeLines(classified.outOfScope, indent);
  }
  return untrackedLines(indent);
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
    const classified = classifyFailure(testResult.testFilePath, fullName);
    const known = classified.known;
    lines.push("", color("31", `✕ ${fullName}`));
    lines.push(...classifiedFailureLines(classified, "  "));
    const apps = allApps.filter((app) =>
      matchesFailingTest(app, new Set([fullName])),
    );
    for (const app of apps) {
      usedAppIds.add(app.appId);
      lines.push(...appCardLines(app, known, "  "));
    }
  }

  if (testResult.testExecError) {
    lines.push("", color("31", "✕ suite failed to run"));
    lines.push(
      ...classifiedFailureLines(
        classifyFailure(testResult.testFilePath, null),
        "  ",
      ),
    );
  }

  const leftover = allApps.filter((app) => !usedAppIds.has(app.appId));
  if (leftover.length > 0) {
    lines.push("", color("2", "other apps deployed by this file:"));
    for (const app of leftover) {
      lines.push(
        ...appCardLines(
          app,
          classifyFailure(testResult.testFilePath, null).known,
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
    // A pass on an unmapped registry says nothing about the listed
    // environments, so scoped entries only nudge where they are listed.
    if (!known || (known.envs && !known.envs.includes(currentEnvironment()))) {
      continue;
    }
    const scope = known.envs ? known.envs.join(", ") : "all environments";
    lines.push(
      color(
        "32",
        `✔ ${known.ticket} passed here (${currentEnvironment()}) — listed for ${scope}; ` +
          `removal is decided across every listed environment, which Barmin reports per run`,
      ),
    );
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
        ...classifyFailure(suite.testFilePath, null),
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
        ...classifyFailure(suite.testFilePath, fullName),
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
    .map((failure) => {
      if (failure.known) {
        return `- [KNOWN ${failure.known.ticket} ${failure.known.url}] ${failure.fullName} (${failure.file})`;
      }
      if (failure.outOfScope) {
        return (
          `- [UNTRACKED on ${currentEnvironment()} — ${failure.outOfScope.ticket} is registered for ` +
          `${failure.outOfScope.envs.join(", ")}] ${failure.fullName} (${failure.file})`
        );
      }
      return `- [UNTRACKED] ${failure.fullName} (${failure.file})`;
    })
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
      lines.push(
        failure.outOfScope
          ? `  ✕ ${failure.fullName} — ${failure.file} (${color("33", failure.outOfScope.ticket)} is registered for ${failure.outOfScope.envs.join(", ")}, not ${currentEnvironment()})`
          : `  ✕ ${failure.fullName} — ${failure.file}`,
      );
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
  if (untracked.length === 0) {
    lines.push(
      "",
      color(
        "32",
        "✓ All failures are known issues — you didn't regress anything.",
      ),
      "",
    );
    return lines;
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
        environment: currentEnvironment(),
        suiteErrors: [],
        tests: [],
      };
      for (const suite of results.testResults ?? []) {
        const file = path.relative(process.cwd(), suite.testFilePath);
        if (suite.testExecError) {
          record.suiteErrors.push({
            file,
            message: String(
              suite.testExecError.message ?? suite.testExecError,
            ).slice(0, 2000),
            ...summaryIssueFields(classifyFailure(suite.testFilePath, null)),
          });
        }
        for (const result of suite.testResults ?? []) {
          const fullName = [...result.ancestorTitles, result.title].join(" ");
          const entry = findKnownIssue(suite.testFilePath, fullName);
          record.tests.push({
            file,
            fullName,
            status: result.status,
            durationMs: result.duration ?? null,
            ...summaryIssueFields({
              known: entry && appliesToCurrentEnvironment(entry) ? entry : null,
              outOfScope:
                entry && !appliesToCurrentEnvironment(entry) ? entry : null,
            }),
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
