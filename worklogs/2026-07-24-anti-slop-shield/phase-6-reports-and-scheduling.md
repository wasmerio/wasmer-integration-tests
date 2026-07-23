# Phase 6 — Reports and scheduling

**Status:** Complete  
**Worklog:** [Anti Slop Shield v1](README.md)

## Goal

Make every run reviewable and schedule qualified persisted scenarios without bespoke glue.

## Specification

Complete QA-641 and QA-642. Write a machine-readable report and human summary for every run identifying scenario, resolved fixture versions, executor, target environment, load shape, verdict fact, derived assessment (D6: lifecycle × pinned/floating mode), lifecycle state, check evidence, and raw-log locations. Commands print verdict, assessment, and report path. Redact tokens and other credentials.

Create the reusable pipeline workflow with scenario, environment, executor, and threshold inputs. It accepts committed persisted scenarios only and alerts on the assessment, never the raw verdict fact — an `open` scenario reproducing on pins is quiet; a `fixed` scenario reproducing on floating selectors pages. Record a scenario's disposition through `meta.lifecycle`: `fixed` scenarios stay scheduled as regression watch; `retired` scenarios name their blocking-suite successor and leave the schedule.

Implement `ass audit` (local checks): list `open` scenarios by age, and flag `fixed` scenarios whose most recent floating report reproduced. The Linear cross-check (lifecycle vs. ticket state) is recorded as a follow-up requiring CI credentials, not implemented here.

## Integration contract

| Trigger                    | Collaborators             | Observable result                               | Required side effect     | Prohibited side effect                         |
| -------------------------- | ------------------------- | ----------------------------------------------- | ------------------------ | ---------------------------------------------- |
| Any completed run          | report writer             | JSON and human summary, path printed            | Retain declared evidence | Include secrets.                               |
| Pipeline dispatch          | persisted scenario and CI | Selected scenario executes with supplied inputs | Publish report artifact  | Schedule drafts or unqualified stress targets. |
| Fixed scenario disposition | repro metadata            | Recorded blocking-suite or scheduled status     | Update provenance        | Lose investigation history.                    |

## Acceptance criteria

- [x] Reports are schema-validated, redact secrets, and are emitted for all four outcomes, carrying both verdict fact and derived assessment. — `runReportSchema` runs inside `writeReport` on every emit path (a violation is an internal fault, tested); `redactReport(secretsOf(execEnv))` scrubs the whole value tree before both the file and the summary, proven end-to-end by "a secret captured in remote evidence never reaches the report file"; all four outcomes already emit through the same `deliver` seam (reproduced/not-reproduced/inconclusive/setup-failed each exercised across `runner.test.ts`/`remote.test.ts`/`executors.test.ts`, now schema-checked on every write).
- [x] A `fixed`-lifecycle scenario reproducing under floating selectors produces an alerting pipeline outcome; the same fact under an `open` lifecycle on pins does not. — `phase6.test.ts` "the alerting seam (D6) through the real CLI": exit 2 + `alert` vs. exit 0 on the same reproducing fact; the workflow fails on exit 2 unconditionally.
- [x] `ass audit` surfaces open-scenario age and unflagged regressions from local reports. — `ass/report/audit.ts` + CLI command; stalest-first open listing with never-run markers, `REGRESSION` flag (exit 2) for a fixed scenario whose latest floating report reproduced, retired successors listed, drafts ignored. Live smoke: `./bin/ass audit` on the repo lists wax-600/wax-603.
- [x] A report-based integration test proves fixture versions, executor, target, load shape, verdict, and log locations are recoverable. — "fixture versions, executor, target, load shape, verdict and logs are recoverable": selectors + components, `executor.{name,profile}`, `target.{env,mode}`, outcome + assessment, `workload.command`, every `workload.logs` path readable, phase timings present.
- [x] The workflow rejects experimental scenarios and has a dispatch test for a persisted scenario. — `ass run` resolves slugs against `repros/` only (loader boundary, tested since Phase 1), so a draft slug exits 1 before anything runs; the workflow config tests assert dispatch/call inputs, the exit-code mapping, and artifact upload; a persisted dispatch is exercised end-to-end through the same `runCli` entry the workflow invokes.
- [x] Scheduled Bugtopia work is gated on documented qualification. — The workflow declares no `schedule:` trigger (asserted by test), names QA-643 in its header, and prod is not even a dispatchable environment (interactive gates cannot run in CI, asserted by test).

## Error coverage

| Condition                             | Expected outcome                                       | Test                                                                                                         |
| ------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Report directory unwritable           | Actionable failure without hiding run verdict/evidence | `phase6.test.ts` "an unwritable report path costs the file, never the verdict" (summary + exit code intact)  |
| Sensitive value in outcome            | Redacted output                                        | "redaction scrubs secret values wherever they appear"; "a secret captured in remote evidence never reaches…" |
| Workflow receives draft slug          | Validation failure before run                          | `ass run` searches `repros/` only (loader tests); a draft slug exits 1 — the workflow inherits the boundary  |
| Required report artifact upload fails | Visible CI failure with local report path              | "a missing report artifact is a visible failure" (`if-no-files-found: error`; paths listed in the step)      |

## Implementation notes

### Session 1 — 2026-08-10

**Deltas from the specification.**

- **The report writer did not need a rewrite — it needed a contract.** The
  RunReport shape has carried scenario/versions/executor/target/outcome/
  assessment/evidence/log-locations since Phase 2; what Phase 6 added is
  `runReportSchema` enforced inside `writeReport` (strict on the
  load-bearing spine, open on executor payloads so a new executor field
  never invalidates old reports), `redactReport` over the _whole value
  tree_ (evidence quotes captured logs, and captured logs can quote
  anything — field-name-based redaction is how tokens leak), and one
  `deliver` seam in the runner so every emit path redacts, tolerates an
  unwritable directory (the file is lost, the verdict never is), and lets
  schema violations propagate as internal faults.
- **"Threshold input" is the failure threshold.** The workflow's
  `fail-threshold` chooses whether exit 3 (inconclusive) fails the job;
  exit 2 (alerting assessment) always fails and exit 0 never does — the
  D15 code _is_ the assessment, so the workflow contains no verdict logic
  at all.
- **Prod is not a dispatchable environment.** The interactive confirmation
  is one of prod's three gates and CI cannot give it; offering prod in a
  dispatch dropdown would either bypass the gate or always fail. Tested.
- **`ass audit` ages scenarios by local runs, not tickets.** The Linear
  cross-check (lifecycle vs. ticket state) needs CI credentials and stays
  a recorded follow-up (QA-641); what is auditable offline is "when did
  anything on this machine last run this repro" (stalest first, never-run
  called out) and "does any local floating report contradict a `fixed`
  lifecycle" (flagged as REGRESSION, exit 2 — the audit's own alerting
  assessment).
- **Scheduling remains deliberately absent.** D5 gates scheduled load on
  QA-643's Bugtopia qualification; the workflow supports dispatch and
  call, has no cron, and says why in its header. `fixed` scenarios'
  regression watch therefore runs through explicit dispatch (or the
  eventual schedule once qualified); `retired` scenarios leave the
  corpus-of-scheduled-things by construction since audit lists their
  successor and the workflow takes slugs, not globs.

**Verification.**

- `npx jest tests/ass` — 17 suites, **300** tests (17 new in
  `tests/ass/phase6.test.ts`).
- `make fmt` + `make lint` — clean (typecheck, eslint, Prettier, 36 Python
  tests).
- `./bin/ass audit` live on the repo: lists wax-600 and wax-603 (both
  `open`, both run today), exit 0.

## Review findings (review 7, 2026-08-10)

Verified independently: `npx jest tests/ass` (17 suites, 300 pass) and
`make lint` fully clean. Traced the `deliver` seam onto all three emit
paths (fixture-resolution setup failure, workload-execution failure, main),
confirmed the summary always renders from the redacted report, that a
schema violation propagates as an internal fault instead of being swallowed
by the unwritable-directory tolerance, and that `secretsOf` cannot match
the registry URL. The workflow YAML is parse-validated by its own tests;
the no-cron and no-prod invariants are asserted, not just written down.

- [x] **R7-01 (Minor, fixed this session).** The workflow was authored
      with `inputs.fail-threshold` — hyphenated property access is invalid
      in GitHub expressions, so the exit-3 mapping would never see its
      threshold — and with an invented secret name
      (`WASMER_CIUSER_PROD_TOKEN`) that resolves empty. Renamed to
      `fail_threshold`, inputs now pass through `env:` (no shell splicing),
      and identity falls back to the repo's real per-env CI tokens
      (`DEV_BACKEND_CIUSER_TOKEN` / `BUGT_BACKEND_CIUSER_TOKEN`).
- [x] **R7-02 (Minor, fixed this session).** `ass audit` crashed on the
      first persisted scenario that no longer parses — exactly the corpus
      rot an audit exists to surface. Unloadable repros are now listed by
      slug with the first error line, and the rest of the audit completes.
- [ ] **R7-03 (Note).** Live-streamed workload lines (the presenter's
      quoted child output) sit outside the redaction boundary; only the
      persisted report and the summary are scrubbed. Terminal-only
      exposure, accepted for v1.

Verdict: **ready** — both Minors were introduced and fixed within this
phase's session; the remaining finding is a terminal-only note.
