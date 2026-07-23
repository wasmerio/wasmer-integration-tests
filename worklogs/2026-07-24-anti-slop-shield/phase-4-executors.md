# Phase 4 — Executors

**Status:** Complete  
**Worklog:** [Anti Slop Shield v1](README.md)

## Goal

Execute Jest, HTTP load, and raw Wasmer workloads through one observable outcome contract.

## Specification

Prerequisite: the WAX-603 exemplar script and probe directory live only on the unmerged `wax-603-wasix-timed-waits-never-expire` branch; merge it before starting this phase so the equivalence claim below is verifiable (D9).

Complete QA-637–QA-639. Preserve the Jest executor from the reference reproduction. Implement `artillery-http` with an Artillery-native block, reusable ECO-403 WordPress flow-generation knowledge where applicable, and interpolation of resolved fixture values such as `{{ victim.url }}`. Implement `raw-wasmer` as selected-binary `wasmer run` process workloads, plus the engine-aware `host-process` spawn-and-capture micro-executor that baselines and control runs require (D8/D10), dispatching `engine:` names (`python3`, `node`, `go`, `cargo`, `binary`) to their host invocation conventions. Do not introduce HAR replay or a custom Artillery Wasmer engine in v1 (D3).

Every executor returns the same timing, check-counter, captured-output, and raw-log-location shape; `output_matches` predicates evaluate the captured output, and the D11 `ASS-VERDICT:` marker line is parsed from the declared channels (stderr capture for process executors, response body for HTTP) with exactly-once semantics and the exit-status consistency cross-check (dead-by-signal or nonzero exit + healthy verdict line ⇒ `inconclusive`). Fixture declarations may declare executor compatibility; changing the active executor profile or target must not require rewriting fixtures or verdict.

Create `repros/wax-603/scenario.yaml` as the raw-wasmer reference: probe fixture (`package:` source with path affordance), pinned `python` package component overridable via `path:` for fix verification, `raw-wasmer` default profile with an `artillery-http` profile declared for later remote use, the D11 probe contract on `{type: log, stream: stderr}` (the probe's `repro.py` gains the `ASS-VERDICT:` emission), and the `python3` native baseline expecting `not-reproduced` (D10). It must replace the WAX-603 script's `local` and `native` modes; the dev/prod modes follow in Phase 5.

## Integration contract

| Trigger         | Collaborators                  | Observable result                                             | Required side effect          | Prohibited side effect              |
| --------------- | ------------------------------ | ------------------------------------------------------------- | ----------------------------- | ----------------------------------- |
| Jest load       | Jest and resolved state        | Common outcome with test logs                                 | Execute selected spec/pattern | Executor-specific fixture mutation. |
| Artillery load  | Artillery and app URL          | Native phases/flows execute; thresholds become verdict inputs | Retain Artillery result       | Invent a second HTTP DSL.           |
| Raw Wasmer load | selected Wasmer binary/package | Common outcome with process logs                              | Run declared command          | Require Artillery.                  |

## Acceptance criteria

- [x] All executors (including `host-process`) satisfy a compile-time and runtime common-outcome contract. — `Executor`/`RunOutcome` in `ass/executors/contract.ts` (compile-time); `assertRunOutcome` runs on every dispatch, including baselines and controls (runtime). Tests: `tests/ass/executors.test.ts` "the common outcome contract (AC-1)".
- [x] Artillery runs a real local target with resolved URL interpolation and threshold verdict data. — `tests/ass/artillery.test.ts` drives the real `artillery` binary against an in-process HTTP server: 5 requests reach it, `{{ victim.url }}` appears in the generated script, `http.codes.200` arrives as a counter, and a breached `p95` threshold exits non-zero with the latency in `counters`.
- [x] Raw Wasmer runs a fixture/package using a caller-selected binary. — `ass/executors/rawWasmer.ts`; binary precedence `binary:` → `WASMER_PATH` → PATH, argv equals the WAX-603 script's own invocation. Tests: "raw-wasmer executor (QA-639, AC-3)"; proven live by the `ass run wax-603` round below.
- [x] `ass run wax-603` reproduces via the D11 probe contract (`ASS-VERDICT:` on captured stderr), and its `python3` baseline passes; a violated baseline/control, a missing baseline engine, a missing/conflicting verdict line, or an exit-status contradiction yields `inconclusive` (or a marked degraded run), never `not-reproduced`. — Live run 2026-08-07: `reproduced` / `expected` / exit 0, `probe reported reproduced — 5 primitive(s) broken on log:stderr`, baseline `not-reproduced (expected not-reproduced) host-process:python3`, 29.9s total. Each failure mode has its own test in "the ASS-VERDICT probe contract (D11)", "declared controls (D8)" and "probe scenarios end to end".
- [x] Incompatible fixture/executor combinations fail before workload execution. — `preflightLoad` (`ass/engine/capabilities.ts`) rejects an unknown executor, an unparseable profile, an undeclared `{{ … }}` reference, and a fixture whose `executors:` excludes the active profile, all before `resolveLocal` is called. Tests: "preflight before any workload runs (AC-5)", each asserting the fake driver recorded no calls.

## Error coverage

| Condition                                                                    | Expected outcome                                                           | Test                                                                                                                           |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Unknown executor                                                             | Schema/dispatch error                                                      | `schema.test.ts` "a profile naming no known executor"; `executors.test.ts` "an unknown executor is a dispatch error"           |
| No `ASS-VERDICT:` line, or conflicting lines                                 | `inconclusive` with captured output retained                               | `executors.test.ts` "no line at all is inconclusive", "conflicting outcomes", "a silent probe is inconclusive" (reads the log) |
| Verdict line claims `not-reproduced` but process died by signal/nonzero exit | `inconclusive`; contradiction named in report                              | `executors.test.ts` "a healthy verdict from a process that died is a named contradiction"                                      |
| Baseline or control run violates its expected outcome                        | `inconclusive`; violation named in report                                  | `executors.test.ts` "a violated baseline is inconclusive"; "a control that violates its expectation"                           |
| Baseline engine absent on host                                               | Run degrades with visible "baseline not exercised" marker; promote refuses | `executors.test.ts` "a missing baseline engine degrades the run visibly"; `promote.test.ts` "an unexercised native baseline"   |
| Harness backstop timeout kills a probe                                       | `inconclusive`, not `not-reproduced`                                       | `executors.test.ts` "the backstop timeout kills a hanging child" (real 60s sleep, 1s cap) and "never not-reproduced"           |
| Artillery threshold failure                                                  | `not-reproduced` with threshold evidence                                   | `artillery.test.ts` "a failed threshold is a result, not a crash"                                                              |
| Missing selected Wasmer binary                                               | Actionable preflight error                                                 | `executors.test.ts` "a selected binary that does not exist is an actionable preflight error"                                   |
| Child process timeout/nonzero exit                                           | Captured outcome/log location and cleanup                                  | `executors.test.ts` "a nonzero child exit is captured, not thrown" (real python3)                                              |
| Unresolved template variable                                                 | Preflight failure naming variable                                          | `executors.test.ts` "an unresolvable template variable fails preflight naming it"                                              |

## Implementation notes

### Session 1 — 2026-08-07

Prerequisite discharged first: the `wax-603-wasix-timed-waits-never-expire`
branch was merged by the driver, so the equivalence claim below is checkable
against the script it replaces.

**Deltas from the specification.**

- **`repros/wax-603/` runs without booting the local platform.** The spec did
  not raise it, but a `raw-wasmer` probe asks nothing of Edge or the backend,
  and paying ~6 minutes of container boot to run `wasmer run` would make the
  fast end of the investigation path the slow one — the exact friction that
  keeps people writing shell scripts. `requiresPlatform()` (`ass/fixtures/local.ts`)
  now decides from the declaration: a platform component (`edge`/`backend`),
  an app fixture, a perturbation, or a verdict that reads a platform-process
  log. WAX-600 has all four and is unaffected; WAX-603 has none and completes
  in **29.9s**. Nothing is mutated on that path, so cleanup is a no-op and the
  interrupt trap has nothing to restore.
- **Package components (D8) are a component kind, not a fixture.** A component
  that is not `edge`/`backend` resolves to `{{ component.<name> }}` for the
  executor instead of a local-platform env var. `registry:python/python@=3.13.5`
  is ASS's _pinning_ grammar, so it is translated to what the tool accepts
  (`python/python@3.13.5`); `path:` resolves against the scenario dir. This is
  what makes `--component python=path:/my/build` the replacement for the
  script's `PYTHON_PKG=`, through the existing D12 surface and with no new
  flag. Phase 2's "component X cannot resolve on the local target" error is
  gone: there is no such thing anymore.
- **A load profile may name its executor.** Found by a test that could not be
  written: profile-name-is-executor-name makes two `raw-wasmer` profiles
  impossible, and D8's own "comparing two guest engine versions" control needs
  exactly that. A profile is still named after its executor by default, but
  `executor: raw-wasmer` _inside_ a profile frees the name. `load.executors`
  maps profile → executor; the key is stripped before the executor's strict
  profile schema sees it. This also turned "unknown executor" from a runtime
  dispatch error into a schema error, which is where the error-coverage matrix
  asks for it.
- **Baseline judgeability is a preflight, not a surprise.** A native baseline
  is a host process, so a verdict that decides purely on `edge`/`backend` logs
  can never judge one — it would score `inconclusive` after the fact and read
  as a broken probe rather than a declaration gap. `preflightVerdict` now
  refuses it up front, naming the two ways out (`verdict.probe` /
  `output_matches`, or waive with a reason).
- **Probe channels are executor-relative.** `usableChannels()` intersects the
  declared channels with what the active executor can deliver: a `log` channel
  is inert under `artillery-http` and an `http` channel is inert under
  `raw-wasmer`. Declared-but-inert is not an error — that is what lets
  `repros/wax-603/` carry both channels and one verdict across the local and
  (Phase 5) remote profiles. Only "no declared channel can carry a verdict
  here" fails preflight, and it says why.
- **`ensure:` needs its plugin listed.** Artillery 2.x silently ignores
  `config.ensure` unless `plugins.ensure` is present, so a threshold-declaring
  load test would have reported green having checked nothing. The executor adds
  it. Found by the integration test, not by reading the docs.
- **Artillery's `--output` JSON is the verdict input.** `aggregate.counters`
  and `aggregate.summaries` flatten into `RunOutcome.counters`, so a breached
  threshold arrives as data (`http.response_time.p95`) rather than only as a
  non-zero exit. The generated script is retained as
  `<label>.artillery.yaml` — the first thing to check when a load run targets
  the wrong thing.

**Structural notes.** `ass/executors/process.ts` is now the single
spawn-and-capture boundary (moved out of `jest.ts`); every executor differs
only in the argv it builds and honours `ctx.label`, so a control cannot
overwrite the measured workload's logs. `PreflightError` moved to
`ass/errors.ts` because executors raise it too and the engine must not become
a dependency of what it dispatches. `evaluateVerdict` gained the probe as a
first-class input, and the same call judges the baseline against
`NO_STREAM_SOURCES` — one verdict definition, two subjects.

**Deliberately not done.** The `{type: http, match: body}` read path needs
harness-owned probe deployment (D9), which is Phase 5; declaring it today
fails preflight saying so, and `ass run wax-603 --executor artillery-http`
therefore refuses with the same message. `log_matches` on app-instance
streams (`app`/`stdout`/`stderr`) still needs Vector→Loki and stays gated.
The WAX-603 script keeps its `dev1`/`prod` modes and now reads
`repros/wax-603/probe/`, so there is one copy of the matrix.

**Verification.**

- `npx jest tests/ass` — 15 suites, **265** tests pass (65 new).
- `make fmt` clean; `make lint` clean for TypeScript (`fmt-check`, suite
  coverage, `tsc --noEmit`, eslint over `./src ./tests ./bin ./ass`). It
  currently **fails in the Python leg** on
  `test_localplatform.TestSeedPackages.test_merge_dedupe_and_comments`, which
  is pre-existing merge skew, not Phase 4 — see the README journal entry.
- `./bin/ass run wax-603` — live, twice: `reproduced` / `expected` / exit 0,
  `probe reported reproduced — 5 primitive(s) broken on log:stderr`, baseline
  `not-reproduced (expected not-reproduced) host-process:python3`. 29.9s
  (setup 0.0s, workload 21.3s, comparison 8.6s).
- `./bin/ass run wax-600` — **not verified this session**: the boot failed at
  `setup-failed` / exit 4 because an unrelated local-platform stack
  (`wit_20260807t111414z_a4a3aca`) was already holding port 18000. The
  diagnosis block named the cause correctly. Its orchestration path is covered
  by `tests/ass/runner.test.ts` against the fake harness, but the real
  regression run should be repeated once the machine is free.

## Review findings (review 5, 2026-08-10)

Verified independently: `npx jest tests/ass` (15 suites, 265 pass);
`make lint` fully clean including the Python leg — the Phase 4 session's
merge-skew blocker was resolved this session by adopting main's own updated
`test_merge_dedupe_and_comments` expectations (main fixed the test alongside
`5d6d6bc`; the branch's copy predated it, so the eventual merge now
auto-resolves). `./bin/ass run wax-603` re-run live: `reproduced` /
`expected` / exit 0, `probe reported reproduced — 5 primitive(s) broken on
log:stderr`, baseline `not-reproduced (expected not-reproduced)`, 30.0s.

Traced good: `assertRunOutcome` guards every dispatch path (runner workload,
`runNative`, `runProfileControl`); comparisons run after the measured
workload with `control-<name>`/`baseline` labels so they cannot overwrite
its logs; a violated comparison forces `inconclusive` on every non-setup
path and `ass promote` refuses any `state.baseline` ≠ `ok` (absent-key
records from pre-Phase-4 runs included, via `?? "not-run"`); the D11
cross-check demotes only healthy claims, so a probe that reports
`reproduced` and then crashes keeps its claim, which is the right asymmetry
for crash bugs; `preflightLoad` rejects unknown executor, unparseable
profile, undeclared `{{ … }}` reference and fixture-executor exclusion
before any fixture resolves, each with the fake driver recording zero calls.
The stale-backup refusal also proved itself en route: the wax-600 re-run
first ended `setup-failed` naming a leftover `local.env.ass-bak` (a prior
session's interrupted run), which is exactly the backstop the Phase 2 close
designed for untrappable kills — the message was actionable and restore was
clean.

- [x] **R5-01 (Minor, non-reopening — fixed 2026-08-10 with the Phase 5
      channel plan: `planChannels` + `ProbeEvalContext`; only planned
      channels are ever read, tested by the remote e2e whose workload
      stderr carries a contradicting marker).** The implementation notes claim a `log` channel is _inert_
      under `artillery-http`, but `evaluateVerdict`
      (`ass/engine/verdict.ts`) hands **all** declared channels to
      `evaluateProbe`, and `readChannel` reads `outcome.logs[stream]` —
      which every executor populates with its _own_ process capture. Under
      `artillery-http`, `{type: log, stream: stderr}` therefore reads
      Artillery's stderr, not the probe's. Unreachable in Phase 4 (any
      artillery+probe declaration fails preflight: no usable channel), but
      the moment Phase 5 makes `http` readable the log channel silently
      joins evaluation on the wrong stream — e.g. `DEBUG=http:response`
      makes Artillery echo response bodies to stderr, so the same marker is
      read twice and a multi-request flow can manufacture a
      conflicting-tokens `inconclusive`. Fix: evaluate only
      `usableChannels(channels, activeExecutor)` (the function preflight
      already uses), threaded from the runner.
- [x] **R5-02 (Note — fixed 2026-08-10; `baselineSpecOf` used in the runner
      and `preflightVerdict`).** `runScenario`'s `declared` check uses
      `!("waived" in verdict.baseline)` — the exact non-discriminating
      pattern `baselineSpecOf` exists to replace (its own doc comment says
      `in` does not discriminate this union). Harmless today because a
      parsed spec never carries a `waived` own-key, but the helper should be
      used so the discrimination logic lives in one place.
- [x] **R5-03 (Note — closed by the review itself).** AC-4's regression leg (`ass run wax-600` on the
      executor-dispatch runner) was left unverified by the implementing
      session; this review re-ran it live. Result recorded in the README
      journal (Review 5 entry).
