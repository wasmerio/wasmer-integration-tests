#!/usr/bin/env node
// Guard against test-suite drift: every tests/**/*.test.ts must be selected
// by at least one test_command in .github/integration-test-suites.json, which
// drives BOTH the PR local-platform pipeline and the nightly dev/bugt/prod
// pipelines. Files not matched there never run in any CI (found 2026-07-23:
// seven test files had silently accumulated outside the matrix).
//
// Runs as part of `make check` / `make lint`, so a PR adding a test file
// without suite coverage fails the always-on lint job with an actionable
// message instead of silently shipping a test that never executes.

import console from "node:console";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITES_FILE = path.join(ROOT, ".github", "integration-test-suites.json");
const TESTS_DIR = path.join(ROOT, "tests");

// Files intentionally not run by any CI suite. Every entry needs a reason.
const EXCLUDED = new Map([
  // (none currently)
]);

function collectTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (entry.name.endsWith(".test.ts")) {
      out.push(path.relative(ROOT, full));
    }
  }
  return out;
}

// Parse one test_command line into jest positional patterns + ignore patterns.
// Handles leading FOO=bar env assignments and --testPathIgnorePatterns=x.
function parseJestLine(line) {
  const tokens = line.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) {
    i++;
  }
  if (tokens[i] !== "npx" || tokens[i + 1] !== "jest") {
    throw new Error(
      `Cannot parse test_command line (expected 'npx jest ...'): ${line}`,
    );
  }
  i += 2;
  const patterns = [];
  const ignorePatterns = [];
  for (; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("--testPathIgnorePatterns=")) {
      ignorePatterns.push(token.split("=").slice(1).join("="));
    } else if (token.startsWith("--")) {
      // Other flags do not affect file selection for our purposes.
      continue;
    } else {
      patterns.push(token);
    }
  }
  return { patterns, ignorePatterns };
}

// Jest matches testPathPattern regexes against the absolute file path, so a
// leading "./" in a pattern matches via the parent directory name. Emulate by
// prefixing a stand-in root.
function jestMatches(pattern, file) {
  return new RegExp(pattern).test(`/repo/${file}`);
}

const suites = JSON.parse(fs.readFileSync(SUITES_FILE, "utf8"));
const selectors = suites.flatMap((suite) =>
  suite.test_command
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseJestLine),
);

const uncovered = [];
for (const file of collectTestFiles(TESTS_DIR).sort()) {
  if (EXCLUDED.has(file)) {
    continue;
  }
  const covered = selectors.some(
    ({ patterns, ignorePatterns }) =>
      patterns.some((p) => jestMatches(p, file)) &&
      !ignorePatterns.some((p) => jestMatches(p, file)),
  );
  if (!covered) {
    uncovered.push(file);
  }
}

const staleExclusions = [...EXCLUDED.keys()].filter(
  (file) => !fs.existsSync(path.join(ROOT, file)),
);

if (uncovered.length > 0 || staleExclusions.length > 0) {
  for (const file of uncovered) {
    console.error(
      `NOT RUN IN CI: ${file} is not matched by any test_command in .github/integration-test-suites.json`,
    );
  }
  for (const file of staleExclusions) {
    console.error(
      `STALE EXCLUSION: ${file} is listed in bin/check-suite-coverage.mjs but does not exist`,
    );
  }
  console.error(
    "\nAdd the file to a suite in .github/integration-test-suites.json (or to the EXCLUDED map in bin/check-suite-coverage.mjs with a reason).",
  );
  process.exit(1);
}

console.log("suite coverage OK: every tests/**/*.test.ts is run by CI");
