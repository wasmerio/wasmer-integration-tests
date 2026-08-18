---
name: file-known-issue
description: Register a product bug reproduced by an integration test as a tracked known issue — file the Linear ticket in standard format and wire it into known-issues.jsonc so the reporter and Barmin flag the failure as KNOWN instead of UNTRACKED. Use when a test failure is diagnosed as a product defect, e.g. "mark this as a known issue", "this failure is BE-1234", "file and track this bug".
license: Proprietary
compatibility: Ticket creation follows the linear-ticket skill (Linear MCP tools when available). Registry wiring is plain file editing.
---

# File a known issue

A failing integration test is either an UNTRACKED failure (nobody has
diagnosed it) or a KNOWN issue (a Linear ticket exists and
`known-issues.jsonc` links the test to it). This skill converts the former
into the latter. Known-issue tests stay red on purpose — pressure stays on
the ticket; never mark them `test.failing`, which hides the failure and
flips to red the moment the bug is fixed.

## Steps

1. **Diagnose enough to route.** Identify the owning team and, when
   findable, the regression commit. The failing jest test is your
   reproduction — do not file without one that a stranger can run.
2. **File the ticket with the `linear-ticket` skill.** The Reproduction
   section must include the exact test invocation, e.g.
   `npx jest tests/app/app_ban_unban_roundtrip.test.ts` (plus a faster
   CLI-only repro if one exists under `repros/`).
3. **Register in `known-issues.jsonc`** at the repo root. Key is
   `<file>::<fullName>` where fullName is describe titles + test title
   joined with single spaces; a file-only key covers suite-level load
   errors; a describe-title key covers all tests under it. Include the
   ticket ID and a one-line note.
   Add `"envs"` when the bug is environment-specific — any of `dev`,
   `bugt`, `prod`, `local` — and list only the environments where you
   observed it. Omit the field when the bug is environment-independent;
   omitting means every environment, as before. Scoping is what keeps a
   prod-only entry from nudging on every dev run, so scope by what you
   saw, not by what you assume:

   ```jsonc
   "tests/app/cdn-cache.test.ts::app CDN cache smoke cdn cache honors HTTP semantics, purge, and cache key isolation": {
     "ticket": "EDGE-1994",
     "envs": ["prod", "bugt"],
     "note": "prod red 7 of 7 nights Aug 12-18; bugt red 3 of 6 since Aug 16",
   },
   ```

   A scoped entry that fails on an unlisted environment reports as
   UNTRACKED with a pointer to the ticket. That is the signal to comment
   on the ticket and widen the list — not to file a duplicate. Unmapped
   registries (local platform) resolve to `local` and match every entry,
   so local runs behave as they always did.
4. **Verify the wiring**: rerun the single failing test and confirm the
   reporter prints `⚠ KNOWN ISSUE <ticket>` instead of
   `🔥 UNTRACKED FAILURE`.
5. If the test does not exist yet, create it first via the
   `add-integration-test` skill — a known issue without a reproducing test
   cannot be tracked by this system.

## Removal

When the ticket is fixed and the test passes, the reporter prints a one-line
nudge on the environments the entry lists. A single green environment is not
evidence: Barmin promotes an entry to "green in every listed environment"
only when every environment it claims passed in the same run. Delete the
registry entry in the PR that confirms the fix, and prefer narrowing `envs`
over deleting when only one environment recovered.

## Validate

- Ticket follows the linear-ticket format and links the test as
  reproduction.
- Registry key matches the jest fullName exactly (space-joined, no `>`).
- `envs`, when present, lists only environments where the failure was
  observed, and uses the tokens dev / bugt / prod / local.
- Single-test rerun shows the KNOWN ISSUE banner with the ticket URL.
- No `test.failing` marker on the test.
