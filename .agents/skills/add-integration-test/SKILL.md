---
name: add-integration-test
description: Author or modify integration tests in wasmer-integration-tests so they run in CI, reproduce on every environment, and read as verifiable product claims. Use when asked to add a test, write a regression test, reproduce a bug in a test, extend a test suite, or wire a test file into the CI matrix.
---

# Add integration test

## When to use

Use this skill whenever creating a new `tests/**/*.test.ts` file or making
substantial changes to an existing one: new coverage, a bug repro, porting a
manual verification into CI.

## Goal

Every test in this repo is a **product claim a human can audit**: someone
reading the file must be able to confirm that each assertion corresponds to a
real promise the platform makes, and CI must actually execute it — on the
local platform, dev, bugt, and prod alike.

## Design rules

### 1. Reproducible on any environment

The same test binary runs against four environments. Nothing in the test may
assume which one.

- Get all environment facts from `TestEnv.fromEnv()`: registry, token,
  `env.namespace`, `env.appDomain`. Never hardcode `wasmer.wtf`,
  `wasmer.dev`, a namespace, a region list, or a URL.
- Name every app with `randomAppName()`. Fixed names collide across
  concurrent CI runs.
- Route HTTP through `env.fetchApp` / `env.fetchAppUrlThroughEdge`, and CLI
  calls through `env.runWasmerCommand`. A raw `fetch` works on dev and hangs
  on the local platform.
- Never assert on wall-clock timing, region names, or account state. For
  eventually-consistent behavior poll with the `sleep` util against a
  deadline; never a single fixed sleep.
- Deploy-heavy tests set an explicit jest timeout as the third `test()`
  argument. Independent tests use `test.concurrent`.

### 2. Clear, concise, human-auditable

- Start the file with a header comment stating **which user-visible behavior
  is asserted and why it matters**, linking the Linear ticket when one
  exists. A reviewer must be able to validate authenticity from the file
  alone.
- Write each test as a linear scenario: arrange, act, assert. No hidden
  control flow, no clever indirection, no assertion helpers that obscure
  what is being compared.
- Assert concrete expected values (`expect(status).toBe(304)`), not
  snapshots or "did not throw".
- One behavior per test. If the description needs "and", split it.

### 3. Fixtures: shared by default, local by exception

- First reuse what exists: app builders in `src/app/construct.ts`
  (`buildStaticSiteApp`, `buildJsWorkerApp`, ...) and packages under
  `fixtures/`.
- A fixture may live inline in the test (via the `files` map of an
  `AppDefinition`) **only while exactly one test uses it**.
- The moment a second test needs the same fixture, promote it: into
  `fixtures/<domain>/` for packages, or into `src/app/construct.ts` as a
  builder. Never copy-paste a fixture between test files.

### 4. Cleanup

- Always tear down apps in a `finally` with `env.deleteApp(appInfo)`. It
  defers deletion so failing tests preserve their app for debugging
  (`KEEP_APPS=1` preserves everything); do not replace it with an immediate
  CLI delete unless the test itself redeploys the same name.

### 5. Bug repros: the pipeline tells the truth

A test that reproduces an **open** bug asserts the *correct* behavior and
therefore fails until the product is fixed. That red status is intentional
and must be preserved: the pipeline is our shared, honest record of known
defects, and keeping the failure visible is how a confirmed bug stays on
the radar until it ships fixed. Follow the BE-1679 pattern
(`tests/app/be-1679-remote-build-alias-wipe.test.ts`):

- File name starts with the ticket slug:
  `tests/<domain>/<ticket>-<what>.test.ts`.
- Declare as a normal `test()` / `test.concurrent()` asserting the desired
  behavior — never `test.failing`, `.skip`, or inverted assertions. The
  moment the fix lands, the test passes unchanged and continues life as the
  regression test; no follow-up edit is needed.
- The header comment carries the ticket URL, states that red-until-fixed is
  expected, and asks readers to coordinate on the ticket rather than skip
  or quarantine the test.
- Link the test file from the ticket, and give the owning team a heads-up
  before merging — a red suite affects everyone's merges, so it should
  arrive as a known, agreed signal with a clear owner, not a surprise.

## Workflow

1. Pick the domain directory under `tests/` (create one only when no
   existing domain fits).
2. Write the test following the design rules above.
3. **Wire it into CI.** A file no suite selects never runs anywhere. Check
   that a `test_command` in `.github/integration-test-suites.json` matches
   the file; a new domain directory needs a new suite entry. Verify with:

   ```bash
   node ./bin/check-suite-coverage.mjs
   npx jest --listTests <pattern-from-the-suite>
   ```

4. Run the test for real before pushing (CI matrix ≠ proof it passes):

   ```bash
   WASMER_NAMESPACE=<namespace-your-token-owns> npx jest tests/<domain>/<file>
   ```

   Debug with `VERBOSE=true`.

5. Gate:

   ```bash
   make fmt
   make lint
   ```

   `make lint` includes the suite-coverage guard, tsc, eslint, and prettier
   check; it must pass cleanly — this is a given, not a goal.

## Validate

- `node ./bin/check-suite-coverage.mjs` reports the file as covered.
- The test passed against dev — or, for an open-bug repro, failed for
  exactly the documented reason, with the ticket linked in the header and
  the owning team aware it is landing red.
- A reader can map every assertion to a product promise without opening
  other files.
- No hardcoded environment facts (grep the diff for `wasmer.wtf`,
  `wasmer.dev`, `wasmer.app`, literal namespaces).
- Apps are cleaned up in `finally`; nothing is left behind on a green run.

## Edge cases and known traps

- `wasmer app create --template <slug>` only scaffolds locally — the backend
  app and its alias are created by the first deploy.
- After a remote-build deploy the CLI rewrites `app.yaml` and currently
  produces invalid YAML (`annotations:` block); rewrite a minimal
  `app.yaml` before redeploying from the same directory.
- Unverified accounts deploy perishable apps (1 h TTL) — harmless for
  tests, but do not assert on the absence of the perishable banner.
- Never log tokens or secrets; `env.runWasmerCommand` output is echoed on
  failure.
- `tests/utils/` is for helper unit tests (run by the `general` suite), not
  for platform scenarios.
