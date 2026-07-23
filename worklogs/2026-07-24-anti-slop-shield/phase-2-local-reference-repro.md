# Phase 2 — Local fixture lifecycle and reference reproduction

**Status:** Complete  
**Worklog:** [Anti Slop Shield v1](README.md)

## Goal

Resolve local fixtures hermetically and make WAX-600 reproducible from a persisted declaration.

## Specification

Implement the QA-635 state-manager portion needed by the local target. It prepares template, fixture, and package app sources; resolves local component selectors; applies local-only CPU/cache perturbations; returns URLs, app IDs, paths, component versions, and a cleanup handle. It honors fixture `config:` declarations (D13): locally, `max_instances: 1` maps to single-replica deployment. It must complete before measurement begins and own restoration of every changed local file or process state.

Create `repros/wax-600/scenario.yaml` from the existing script's exact failing Edge and backend releases, one CPU cap, cache wipes, existing Jest workload, cross-Store log predicate, and panic-context evidence collection. The scenario is stamped `lifecycle: open` (D6), so `reproduced` on pinned versions is the expected assessment. `ass run wax-600` must report `reproduced`, `not-reproduced`, `inconclusive`, or `setup-failed` distinctly. Retire the shell script only after the declarative scenario proves equivalent; retain provenance in the generated scenario README.

## Integration contract

| Trigger                          | Collaborators                   | Observable result                                                      | Required side effect                                | Prohibited side effect                                           |
| -------------------------------- | ------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| Local persisted run              | local-platform, `TestEnv`, Jest | Fixture state exists before workload; verdict and evidence are emitted | Apply selected pins/perturbations and restore state | Leave `local.env`, compose config, caches, or processes mutated. |
| Fixture failure                  | local platform                  | `setup-failed` with context                                            | Cleanup partial state                               | Start workload measurement.                                      |
| Remote target with perturbations | target selector                 | Loud warning                                                           | Ignore perturbations                                | CPU-starve or wipe remote caches.                                |

## Acceptance criteria

- [x] Local template/fixture/package sources resolve to a typed state and clean up after success and failure. _Evidence: `tests/ass/fixtures.test.ts` ("app source grammar", "resolveLocal lifecycle" — success returns typed `ResolvedState`, every failure path runs `down` + `restoreFiles`)._
- [x] The reference scenario replaces every manual behavioral requirement of the WAX-600 script. _Evidence: `tests/ass/runner.test.ts` ("reference scenario declaration") pins the script's exact selectors, CPU cap, cache wipes, Jest workload, panic predicate, and panic-context collection; `repros/wax-600/README.md` records the provenance mapping._
- [x] A real local-platform run proves setup precedes workload and produces a machine-readable verdict with retained panic context. _Evidence: the canonical pinned run `pnpm ass run wax-600` (2026-08-06, run dir `20260806T061207Z-a9c5cb0`) ended `reproduced` / assessment `expected` ("repro intact on the pinned versions") / exit 0, matching `verdict.reproduced_when.any[0]`. `edge_panic_context` retained 5 matches, the first being `thread 'wasm_thread_6' (64) panicked at …/759ca9d/lib/vm/src/store.rs:202:9: assertion left == right failed: object used with the wrong context, left: StoreId(1025), right: StoreId(1537)` — the exact WAX-600 signature, from the pinned wasix revision. Report: `.local-platform/runs/20260806T061207Z-a9c5cb0/ass/report.json`; boot timings in the sibling `diagnostics/timings.json` confirm setup (174s) completed before the workload (174s). Earlier floating run:_ `pnpm ass run wax-600 --edge path:~/.local/bin/edge` (2026-08-05, run dir `20260805T113136Z-a9c5cb0`) completed the full pipeline for real — pins + CPU cap + cache wipes applied before boot, workload ran after setup, verdict `not-reproduced`, assessment `candidate-fix` (floating × open), evidence collection executed, report at `ass/report.json`, cleanup errorless. That run was floating (driver requested the local Edge binary), so no panic fired — together the two runs cover both assessment modes against the same declaration.\_
- [x] Cleanup behavior is tested for setup and workload failures. _Evidence: `tests/ass/fixtures.test.ts` ("a failed boot cleans partial state…", "cleanup errors surface…"); `tests/ass/runner.test.ts` ("a quiet run … alert" and "setup-failed" tests assert `down`/`restore` ran after workload and setup failures)._

## Error coverage

| Condition                                    | Expected outcome                                                                       | Test                                                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Component asset cannot resolve               | `setup-failed` identifying component and selector                                      | `tests/ass/fixtures.test.ts` "an unresolvable component…"; boot-time resolver failures: "a failed boot cleans partial state…" |
| App deployment fails                         | `setup-failed`; partial resources cleaned                                              | `tests/ass/fixtures.test.ts` "a failing app deployment…" (state-manager seam; see notes on the test level)                    |
| Jest workload exits unexpectedly             | `not-reproduced` or explicit workload failure with evidence; cleanup runs              | `tests/ass/runner.test.ts` "runs jest with the resolved env…", "a quiet run on pinned open versions…"                         |
| Expected log unavailable                     | Verdict reports unmet predicate and evidence location                                  | `tests/ass/verdict.test.ts` "an unavailable stream yields inconclusive…", "collect evidence" (missing-stream note + source)   |
| Cleanup itself fails                         | Original failure retained; cleanup error surfaced                                      | `tests/ass/fixtures.test.ts` "cleanup errors surface…"; `tests/ass/runner.test.ts` "cleanup errors surface on stderr…"        |
| Verdict/collect pattern is not a valid regex | Preflight failure (exit 1) naming every offending predicate path; no fixtures resolved | `tests/ass/preflight.test.ts` "an invalid regex pattern fails preflight… (R3-01)"                                             |
| Workload fails to execute (spawn failure)    | `setup-failed` (exit 4) with a written report; cleanup runs                            | `tests/ass/runner.test.ts` "a workload that fails to execute… (R3-02)"                                                        |
| Workload hits the executor timeout           | Run completes; report and summary carry a `timedOut` marker                            | `tests/ass/runner.test.ts` "a timed-out workload is marked… (R3-05)"                                                          |
| Run interrupted mid-boot (SIGINT/SIGTERM)    | Mutated files restored immediately; a still-running stack is named; exit 128+signal    | `tests/ass/runner.test.ts` "an interrupt mid-boot restores mutated files and exits 130"                                       |

## Implementation notes

_Session addendum 8, 2026-08-07: closing the phase — D9 and the interrupt
hole._ Two items stood between the phase and Complete.

**The WAX-600 script is retired.** `repros/WAX-600-edge-wasix-cross-store-panic.sh`
is deleted, having been superseded by `repros/wax-600/` on the equivalence
D9 asked for: the pinned run of 2026-08-06 reproduced the panic the script
was written to catch, and the 2026-08-06 floating run exercised the same
declaration against current releases — something the script could only do by
editing its own environment block. The provenance README now carries both
runs in a table and names commit `a1e41c1` as where the script survives; the
`links.script` entry is gone from the declaration, and the design doc and
worklog objective point at the directory instead of the file. D9's WAX-603
half stays open: that script lives on an unmerged branch and its retirement
belongs to Phase 4/5.

**An interrupted run no longer leaves the checkout mutated.** Addendum 7
recorded this as open, and it contradicts the integration contract's
prohibited side effect directly: SIGINT during a boot that takes minutes —
the most likely moment to press Ctrl-C — left `local.env` and the compose
file carrying ass's pins and CPU cap, recoverable only by hand from the
`.ass-bak` files. `runScenario` now arms a signal trap around the mutating
window (armed before `resolveLocal`, disarmed once cleanup has run) that
restores every backed-up file and exits 128+signal. The restore is
deliberately **synchronous and file-only**: an interrupt is a request to
leave now, so it does not wait out a ~45s container teardown; instead, when
a stack is still up, the handler says so and prints
`make local-platform-down`. Signal delivery and process exit are injected
(`RunnerDeps.signals`/`exit`), so the path is tested by interrupting a fake
boot rather than by signalling the jest worker — the test asserts that
`restore` lands immediately after `up`, that no workload ran, and that 130
was requested.

Carried forward (cosmetic, not contract): a stale `.local-platform/current`
symlink still makes teardown log "No current local platform run found" and
return 1, surfacing as a spurious cleanup warning on an otherwise clean run.

_Session addendum 7, 2026-08-07: a failure with no stated reason._ A
`--edge resolve_prod --backend resolve_prod` run failed in 15s reporting only
"local platform up failed with status 1" — no cause anywhere, `--verbose`
included. Two defects in the presentation layer, both found by spawning the
child command by hand and comparing what it printed against what ass showed:

- **`--verbose` was parsed and then dropped.** The commander action never
  passed `flags.verbose` to `runCommand`, so the escape hatch the summary
  recommends did nothing. The one flag whose entire job is "show me more" was
  inert.
- **Severity was judged after the severity marker was stripped.** `child()`
  removed the `HH:MM:SS ERROR` prefix and then tested the remaining prose
  against a keyword list. The blocking line —
  `Port 15432 for Postgres is already allocated` — matches no keyword, so a
  hard failure was filtered out as routine chatter. Notability now reads the
  tool's own `ERROR`/`WARNING` level _first_, and a notable line's successor
  rides along because it is usually the evidence (the container holding the
  port, the offending flag). ERROR renders red, WARNING yellow.

The environmental causes behind that run, once visible: an orphaned container
stack from an interrupted run still held port 15432 (removed with
`docker compose -p <project> down -v`), and the AWS SSO tokens had expired
overnight, so `BACKEND_VERSION=resolve_prod` could not reach prod EKS to read
the deployed image. Both are now stated plainly in the `diagnosis` block.

Still open from this session: a run interrupted by SIGINT/SIGTERM leaves
`local.env` and the compose file mutated because there is no signal handler
(the stale-backup guard makes it loud rather than silent, and recovery is
`mv <file>.ass-bak <file>`); and a stale `.local-platform/current` symlink
makes the driver attempt a teardown that logs "No current local platform run
found" and returns 1, producing a cosmetic warning on an otherwise fine run.

_Session addendum 6, 2026-08-06: one voice for the whole run._ A repro chains
four programs — pnpm, the local-platform Python CLI, docker compose, Jest —
and each was writing to the terminal in its own format, so a run read as four
tools arguing rather than one. `ass/report/presenter.ts` now owns the
terminal: it opens the same table the summary closes (shared `GUTTER`
constant, same frame, same fading dividers), renders each phase as a key
(`scenario`, `setup`, `workload`, `cleanup`) and everything the chained tools
say as continuation rows indented one step further, so their output reads as
quoted rather than spoken by ass.

- **Nothing escapes.** The driver stopped inheriting stdio and the Jest
  executor stopped mirroring raw chunks to stderr; both now pipe and hand the
  presenter whole lines. Piping is also what makes the Python logger drop its
  own colours and inline progress — it checks `isatty`, now false — so there
  are no competing progress renderers.
- **Quiet by default.** Child lines are dropped unless they look notable
  (error/warning/failed/panic/denied/…); compose's per-container spam is
  filtered outright. `--verbose` (or `VERBOSE=1`) passes everything through.
  The full streams are still captured to the run dir either way, so nothing
  is lost — only deferred.
- **A failure says what to do next.** "fixture resolution or setup failed" is
  a status, not a diagnosis. The presenter now retains the notable lines the
  chained tools emitted and the summary restates them under `diagnosis`
  (they have scrolled far out of view by then), followed by a `next` block
  naming the `--verbose` flag and the retained run's log directory. Proved on
  a real failing run: the root cause (`GitHub download failed for edge …`)
  reads straight off the summary.
- **Frame and keys differ in hue, not only brightness.** The frame was using
  ANSI `94`, whose actual colour the terminal _theme_ picks, so its contrast
  against the key tint was a lottery — and in practice the two blues were
  indistinguishable. Both are explicit RGB now: a cool `rgb(95,175,255)`
  frame against warm `rgb(176,156,130)` keys. Differing in hue is what makes
  them separable at a glance; two shades of the same hue were not, however
  far apart their luminance. A test asserts the warm/cool split and the
  luminance order so the pair cannot drift back together.
- **Keys are tinted wherever they appear, not just in the gutter.** Inline
  `key: value` runs (`scenario`, `target`, `timing`) and the nested names in
  `components`/`evidence` now carry the same muted blue as the gutter keys,
  with values left in the terminal foreground. A shared `pairs()` helper
  styles _after_ measuring, because `truncate` works on visible text and
  would otherwise strip the escapes back off.
- **A phase's first line sits on its key row.** `error` (and `setup`) used to
  leave the key stranded above an empty value with the message starting a row
  below. `step()` now takes the summary line — and an optional tone, so an
  error's first line is red like its continuations.
- **No doubled rule.** The banner's own top rule sits directly above the
  first phase, so `step()` suppresses its divider immediately after a banner;
  two stacked rules read as a mistake.
- **Errors stay inside the frame.** A preflight or profile failure raised
  after the banner used to escape as a bare, differently-formatted stderr
  line below the half-open table — the exact fault this work set out to fix,
  caught by running it. `runCommand` now catches that family, renders it as
  an `error` phase, and closes the frame; the remote-perturbation warning
  moved onto the same path. Errors that predate the banner (bad slug, bad
  flag) still print plainly, because there is no table to put them in.
- **Where our output starts is explicit.** `pnpm run` prints its own two-line
  preamble before ass gets control, and no script can suppress it from the
  inside — only `pnpm -s ass` or `./bin/ass` avoid it. So the banner opens
  with a start rule that waves (`⁀⁀·~·` cycled: two arches, a tilde, dots on the seams — everything mid-cell or above, since baseline-hugging `‿` sat too low to read as part of the same line) — a deliberately
  different texture from the table's own solid `─`, so it reads as "another
  program is speaking" rather than more frame — and an `ass` label naming the
  program taking over. That the
  rule also suits the tool's name is not an accident. `bin/ass`
  exists for the clean invocation and `pnpm ass` points at it.
- **One stream.** The whole table goes to stdout; splitting progress onto
  stderr would tear it in half under redirection. Two tests that asserted the
  old split were updated.
- Verified against a real failing run: banner → scenario → setup with only
  the notable lines → summary, as one table.

_Session: Phase 2 implementation, 2026-08-05 (Claude Code)._ Deltas from the specification:

- **`ResolvedState` widened** (`ass/executors/contract.ts`): added `execEnv` (generated test-env the executor injects), `artifactsDir`, `composeLogPath`, and `cleanup` now returns `Promise<string[]>` of cleanup errors instead of throwing — so the original outcome is never masked (error-coverage row 5).
- **Pin mechanism**: pins are appended to a backed-up `local.env` rather than replacing it (the script replaced it wholesale). Sequential-source semantics make appended pins win while the user's other settings survive the run. Backups use `.ass-bak`/`.ass-absent` markers; a stale backup from a crashed run refuses to be clobbered.
- **Fresh-boot policy**: an existing local-platform run is torn down before mutation — perturbations cannot apply to a reused stack (it was built from the unperturbed compose file with warm caches).
- **D13 local honor is a verification, not a mutation**: the local stack is a single Edge node whose generated config pins `reuse_instance_max_instances_per_node: 1`, so any `max_instances` bound holds by construction; `resolveLocal` verifies the generated config still guarantees this and fails setup loudly on drift.
- **`verdict.collect` typed** in the schema (`{<name>: {stream, pattern, before?, after?}}`, grep-with-context semantics, matches capped at 5) and covered by capability preflight — uncollectable evidence fails preflight like an unevaluable predicate.
- **Engine gates**: schema features without an engine yet (probe capture, non-waived baseline execution, controls, app-instance streams, non-jest executors) fail preflight with "lands in Phase 4/5" errors (D7: no silent degrade); remote targets warn about perturbations and refuse until Phase 5.
- **`--cpus` override semantics**: replaces the value of every declared `cpus` perturbation; if the scenario declares none, it is a usage error (there is no service to guess).
- **cpus value**: the scenario declares `cpus: 1` (design-doc reference declaration and the script's documented retry value); the script's default was `2` with a "retry with 1" hint.
- **Row 2 test level**: the error-coverage matrix asked for a "local integration test" for app-deployment failure; booting the disposable platform inside CI's disposable platform is not feasible, so the row is proven at the state-manager seam with a failing injected deployer, and the real boundary is covered by the AC-3 manual run. Real deployment goes through `TestEnv` (`ass/fixtures/deploy.ts`, lazy-loaded); template deploys skip `tests/utils/template-deploy.ts`'s per-template local normalization quirks for now.
- **CLI**: `runCli` became async (commander `parseAsync`); `ass run` executes on `--env local`; `ass try` remains load-only until Phase 3 wires draft execution.
- The WAX-600 shell script is retained per D9 until the declarative run is proven equivalent; retirement criteria are recorded in `repros/wax-600/README.md`.
- Verification: `npx jest tests/ass` — 8 suites, 154 tests pass. `make fmt` + `make lint` clean (also resolves R2-01).

_Real-run session, 2026-08-05 (same session)._ Six `ass run wax-600` attempts against the real local platform; each failure was a genuine environment defect the harness surfaced distinctly, fixed in place:

- **Run 1 → setup-failed (4)**: cache wipe hit EACCES — compiler-cache entries are root-owned under rootful Docker (the shell script's `rm -rf` has the same latent bug). Fix: `wipeCaches` falls back to a containerized wipe (`docker run busybox find -delete`); covered by a new driver test. Cleanup restored `local.env`/compose byte-for-byte — first real-world validation of the setup-failed path.
- **Run 2 → setup-failed (4)**: tooling-vs-pin schema skew — current bootstrap passes `--app-postgres-host/-port` to `smbe`, which the pinned 2026-07-15 backend predates. Fix (local-platform, in-scope: pinned old components must keep booting or ASS's premise dies): `bootstrap.py` strips exactly the flags smbe rejects and retries; 3 new Python unit tests (26 pass).
- **Run 3 → setup-failed (4)**: `seed-packages.mjs` statically discovered the quoted literal `"wasmer/fh-repro"` from the new `tests/ass/fixtures.test.ts` and prod no longer serves that package. Fix: test fixture renamed to a non-`wasmer` namespace. Gotcha recorded: bare quoted `wasmer/<x>` strings anywhere in `tests/` get mirrored at boot.
- **Runs 4/5**: operator interruption (driver requested the local Edge binary mid-boot); killing run 4's Python child made its Node process run its normal failure-cleanup concurrently with run 5, whose network and backups it destroyed (`.local-platform/current` had moved). Lesson recorded: an interrupted run's cleanup must settle before starting the next.
- **Run 6 → complete (0)**: `--edge path:$HOME/.local/bin/edge` on the pinned backend. Setup (pins, `cpus: 1`, containerized cache wipe) finished before the workload; jest template test ran (failed with a 500 from the starved Edge); Edge stream shows no cross-Store signature → `not-reproduced`, assessment `candidate-fix` per D6 (floating × open), exit 0; `edge_panic_context` evidence collected (0 matches); report machine-readable; cleanup errorless. Note: the 500 with no panic signature is exactly the case a `not_reproduced_when` health proof would separate from `inconclusive`; the declaration mirrors the script (which had none) — candidate `not_reproduced_when` (template serves < 500) is a follow-up consideration.

## Review findings (review 3, 2026-08-05)

Reviewed against the phase contract with the gates re-run and the invariants
traced branch-by-branch (commands and results in the README Review 3 journal
entry). The implemented surface meets the contract; AC-3's pinned
panic-capturing run is honestly open and the status board reflects it. Two
Minor findings must be fixed before the phase can complete; both sit on the
same fault line: **an error raised between workload start and report writing
escapes the D15 exit-code contract entirely** (cleanup still runs via the
`finally`, but no report is written and the process dies as an unhandled
rejection with exit 1, colliding with the usage code).

- [x] **R3-01 (Minor, blocks completion)** — `verdict` / `collect` `pattern`
      fields are validated only as non-empty strings
      (`ass/scenario/schema.ts:168,344`); nothing ever compiles them until
      `new RegExp(pattern)` inside `evaluateVerdict` (`ass/engine/verdict.ts:88,151`),
      _after_ the workload. Reproduced under the fake harness: a persisted
      scenario with `pattern: "panicked at ["` passed preflight, applied pins
      and perturbations, booted, deployed, ran the full workload, then died
      with a raw `SyntaxError: Invalid regular expression` — cleanup ran, but
      no report was written and no D15 code was returned. This violates the
      D7 invariant (an unevaluable predicate fails preflight before fixtures
      resolve): a syntactically invalid pattern is statically unevaluable.
      Fix: compile every `log_matches`/`output_matches`/`collect` pattern in
      `preflightVerdict` (or a schema refine) and fail as a usage/preflight
      error (exit 1) with the predicate path; add an error-coverage row + test.
- [x] **R3-02 (Minor, blocks completion)** — a workload exec that _throws_
      (e.g. spawn failure of `pnpm`, `ass/executors/jest.ts:80-85`) propagates
      out of the `try` in `ass/engine/runner.ts:232-247`: cleanup runs in the
      `finally`, but the error escapes `runScenario` and `runCli` as an
      internal fault — no report, no D15 exit code (unhandled rejection →
      exit 1). Error-coverage row 3 promises "explicit workload failure with
      evidence; cleanup runs"; the evidence half is unmet on this branch, and
      no test exercises it. Fix: catch non-`SetupFailedError` failures around
      execute/evaluate, write a report (workload spawn failure is reasonably
      `setup-failed`; an `evaluateVerdict` fault should still surface as
      internal after R3-01 removes the reachable cause), and add a test with
      a throwing `workloadExec`.
- [x] **R3-03 (Note)** — `localStreamSources.read` (`ass/engine/verdict.ts:200-202`)
      maps stream names `stdout`/`stderr` to the _workload's_ captured output,
      but the capability table (`ass/engine/capabilities.ts:17`) classifies
      those names as app-instance streams (the deployed app's own
      stdout/stderr via Vector→Loki, D11) and `gateUnimplemented` blocks them
      today. The branch is currently unreachable; the day Phase 4 lifts the
      gate, a `log_matches: {stream: stderr}` would silently read the wrong
      source. Delete the branch or leave a loud comment tying it to the gate
      (workload output is already reachable via `output_matches`).
- [x] **R3-04 (Note)** — `deployAppFixture` (`ass/fixtures/deploy.ts:34,69`)
      creates `ass-app-*` dirs under `os.tmpdir()` that no cleanup path
      removes — `ResolvedState.cleanup` only does driver `down` +
      `restoreFiles` (`ass/fixtures/local.ts:168-176`). Same class as R1-06.
      The dirs are surfaced as `<name>.path` variables, so removal belongs at
      the end of the cleanup handle, not at deploy time.
- [x] **R3-05 (Note)** — a jest workload that hits `timeoutSeconds` is
      SIGKILLed (`ass/executors/jest.ts:77-79`) and surfaces only as a bare
      exit code; neither `RunOutcome` nor the report marks the run as timed
      out, so a hung workload folds into not-reproduced/inconclusive
      indistinguishably from a fast healthy run. WAX-603 (timed waits that
      never expire) is precisely a hang repro — Phase 4 will need a
      first-class timed-out marker; deciding it here is cheaper.

**Verified good** (so the next reviewer need not re-derive):

- Gates: `npx jest tests/ass` 8 suites / 154 tests pass; `make lint` fully
  clean including Prettier (R2-01 confirmed fixed), tsc, eslint, suite
  coverage, and the 26 local-platform Python tests.
- The restore invariant holds on every traced branch: all file mutations go
  through `backup()` (stale-backup refusal tested), `restoreFiles()` never
  throws and restores in reverse order (byte-for-byte tested);
  `planResolution` failures occur before any mutation and correctly skip
  cleanup; every post-mutation failure path in `resolveLocal` runs
  `down` + `restoreFiles` and carries cleanup errors without masking the
  original failure. On disk after the six real runs: no `.ass-bak`/
  `.ass-absent` residue, `local.env` and compose file clean.
- D15 flows correctly through both _written_ report paths (setup-failed and
  completed runs); the five real setup-failed reports and the run-6 report
  under `.local-platform/` match the worklog's claims exactly (floating ×
  open × not-reproduced → candidate-fix, exit 0, evidence collected,
  `cleanupErrors: []`).
- AC-2 equivalence: scenario.yaml matches the script's pins, wipe set,
  workload, panic grep, and evidence grep verbatim; the script's manual
  `GH_TOKEN=$(gh auth token)` step is genuinely replaced
  (`local-platform/localplatform/lib.py:991` resolves it); `cpus: 1` vs the
  script's default 2 is documented in the provenance README; the
  `LOCAL_PLATFORM_AUTO_DOWN` inversion (script `1`, driver `0`) is deliberate
  — the ass cleanup handle owns teardown.
- `bootstrap.py` strip-and-retry is bounded (8 rounds), warns per stripped
  flag, preserves the redacted log, and is unit-tested including the
  valueless-flag case.
- D13 local honor verifies the generated edge config after boot and fails
  loudly on drift, tested in both directions; the fresh-boot policy prevents
  perturbations silently not applying to a warm stack.

## Implementation notes — fix round (review 3), 2026-08-05

_Session: R3 fix round, 2026-08-05 (Claude Code, same session as review 3)._
All five findings resolved; deltas from the finding prescriptions:

- **R3-01**: pattern compilation lives in `preflightVerdict`
  (`ass/engine/capabilities.ts`), not a schema refine — the preflight already
  walks every predicate and collect entry with its path in hand, and drafts
  loaded via `ass try` get the same check for free. Error text is the raw
  `SyntaxError` message under the predicate path.
- **R3-02**: only a _throwing workload exec_ is caught and reported as
  `setup-failed` ("the workload failed to execute: …", workload `null` in the
  report, written to the run's `artifactsDir`); a fault in `evaluateVerdict`
  still propagates as an internal error — with patterns compiled at preflight
  its reachable external cause is gone, so a throw there is a genuine bug.
- **R3-03**: deleted the `stdout`/`stderr` workload-capture branches from
  `localStreamSources` (dead behind the Phase-4 gate) and dropped its now
  unused `outcome` parameter; a comment marks the app-instance meaning of
  those names for the Phase-4 implementer.
- **R3-04**: the cleanup handle tracks `deployedDirs` and removes them after
  `down` + `restoreFiles`, appending failures to the cleanup-error list.
- **R3-05**: `WorkloadExec` now resolves `{exitCode, timedOut}`;
  `RunOutcome.timedOut` flows into the report (`workload.timedOut`) and the
  human summary ("hit the executor timeout and was killed"). Semantics stay
  observational in Phase 2 — whether a timed-out run should force
  `inconclusive` is a Phase 4 decision for the WAX-603 hang scenario, where
  a hang can be the _reproduction signal_ rather than noise.
- Verification: `npx jest tests/ass` — 8 suites, **158 tests pass** (4 new:
  R3-01 preflight, R3-02 spawn failure, R3-04 deployed-dir cleanup, R3-05
  timeout marker); `make fmt` + `make lint` clean (incl. 26 Python tests).
- Phase status stays **In Progress**: the review-blocking findings are fixed,
  but AC-3's pinned panic-capturing run (and then D9 script retirement) still
  gate completion.

_Session addendum, 2026-08-05 (same session): backend archive cache._ The
driver's repeated pinned runs exposed that `fetch.py` re-downloads the ~862MB
backend release tar every boot (three identical copies across run dirs; the
Edge binary had a content-addressed cache, the backend archive had none — the
per-run `local-platform-backend:<project>` tag also defeats docker-level
dedup). Fix (local-platform, in-scope for the same reason as the bootstrap
strip-and-retry: repeated pinned runs must be cheap): `materialize_backend_archive`
caches under `.local-platform/cache/backend-archives/<sha256 of source>`,
hardlink in/out, atomic populate, **only for immutable selectors**
(concrete-tag `github-release:`, run-id `artifact:`) — `latest`/`path:`/`url:`
keep floating. No eviction (matches the Edge cache); entries are ~1GB per
pinned version, prune manually. 3 new Python tests (29 pass); the hit path
validated for real against run 6's resolved source (862MB in 0.7ms). The
cache is pre-seeded from run 6's tar. Also: `*.ass-bak`/`*.ass-absent` added
to `.prettierignore`/`.gitignore` — a live run's backups made `make lint`
fail (`fmt-check` has no parser for them), so the gates were unrunnable
while any ass run was in flight.

_Session addendum 2, 2026-08-05 (same session): precompile skip._ Run 6's
timings put boot at 884s: precompile 623s (70%), backend fetch 183s (fixed
above), everything else ~78s. Precompiling the 34 seeded packages into a
compiler cache the scenario **declared wiped** — on an Edge capped at
`cpus: 1` — is contradictory twice over: the work is discarded by intent,
and it partially _undoes_ the cold-cache perturbation for seeded packages
(the measured wax-600 app is a fresh remote-built package, cold either way).
Derivation added to `resolveLocal`: any perturbation wiping `compiler_cache`
boots with `LOCAL_PLATFORM_ENSURE_COMPILED=0` (existing local-platform knob),
logged loudly; scenarios not wiping the compiler cache keep precompilation.
Tests: driver `up(extraEnv)` pass-through and both derivation directions
(158 pass). Expected RTT drops from ~17 min to ~3–4 min (≈60–90s boot +
workload).

_Session addendum 3, 2026-08-06: AC-3 closed + run timing._ The canonical
pinned run reproduced the panic (details on AC-3 above); both optimizations
held — `fetch-backend-image` 183s → 19s (cache hit; the residue is
`docker load` of the 862MB tar) and `precompile` 623s → 0s. Measured RTT
6m33s = boot 174s + workload 174s + teardown ~45s. Remaining hot spots, in
order: **package-seeding 113s** (65% of boot — 34 packages republished into
each fresh backend; the 1.1GB download cache already hits, so this is
publish cost, and most of the set is irrelevant to a template workload),
**workload 174s** (a remote template build, inherent to the declared
workload), **teardown ~45s**. Instrumentation added because further tuning
needs first-class numbers, not log archaeology: `RunReport.timing`
(`{startedAt, finishedAt, seconds, phases[setup|workload|cleanup]}`),
a `timing: total …` summary line, timestamped stderr progress lines from
`ass/main.ts`, and a `verdict: <outcome> — tearing down` line emitted
_before_ cleanup so the answer is not withheld for the ~45s teardown.
`RunnerDeps.now` is the clock seam; covered by a runner test (159 pass).

_Session addendum 4, 2026-08-06: ECR profile follows the registry account._
`--backend resolve_prod` failed setup three times with
`not authorized to perform: ecr:BatchGetImage` on the prod-account registry
`658661676544.dkr.ecr.us-east-1.amazonaws.com/stackmachine`. Cause was not
the harness: `maybe_login_backend_registry` picked the AWS profile from
static config (`BACKEND_ECR_AWS_PROFILE`, commonly `tf-dev` in a developer's
`local.env`) with no regard for which account owns the registry. The
wrong-account profile **logs in successfully** — it mints a valid token for
_its_ account — so the failure only surfaced much later at `docker pull` as
an opaque 403, pointing suspicion at the wrong layer. Fix mirrors
`wasmer/backend`'s Makefile, where the profile follows the environment
(`ACCOUNT_<env>` + `AWS_PROFILE := tf-<env>`, verified with
`sts get-caller-identity` before `docker login`): an ECR hostname carries its
owning account, so `parse_ecr_registry` extracts it and `select_ecr_profile`
picks the first candidate (configured → account-derived → ambient
credentials) that actually authenticates there, warning when it has to
override an explicitly configured profile and degrading with an actionable
message when nothing matches. Ambient credentials win in CI, where no named
profile exists. 7 new Python tests (36 pass); validated against real
credentials — a prod registry with `BACKEND_ECR_AWS_PROFILE=tf-dev`
auto-corrects to `tf-prod`, and a dev registry with the same config is left
untouched (no regression to the normal dev flow).

With auth fixed, the fully floating run completed: `pnpm ass run wax-600
--edge resolve_prod --backend resolve_prod` (run dir
`20260806T064245Z-a9c5cb0`) → `not-reproduced`, assessment `candidate-fix`,
exit 0, on edge `v2026-08-05_1_419b336_dev1` + backend
`stackmachine:v2026-08-03_1_c3252ee`, with no `panicked at` matches at all.
Set against the same-day pinned run that _did_ reproduce, this is the first
real signal that WAX-600 is fixed upstream. It is **not yet sufficient to
flip `lifecycle: fixed`**, for two reasons: the reproduction is a starvation
race, so a single quiet floating run is weaker evidence than a positive one
(the missing `not_reproduced_when` health proof, already flagged in the run-6
note, is exactly what would separate "healthy" from "the workload never got
far enough to race"); and `fixed` requires a concrete `fixed_in`, which needs
a bisect between the reproducing `v2026-07-16_1_fcdd9c4_dev1` and this
quiet `v2026-08-05_1_419b336_dev1`. Timing: total 22m24s (setup 19m20s —
almost entirely the 2.3GB prod ECR pull, which Docker caches by tag for
subsequent runs; workload 2m24s; cleanup 39.4s).

_Session addendum 5, 2026-08-06: run summary presentation._ The summary was
an undifferentiated wall of `label: value` lines, and its evidence block
re-emitted the container's own SGR escapes, smearing color over the output.
Rewritten as a structured, outcome-keyed render (`ass/report/style.ts` +
`formatSummary`):

- **Color is a parameter, never ambient.** `formatSummary(report, path,
{color, width, cwd})`; `colorEnabled()` honors `NO_COLOR`, `FORCE_COLOR`,
  and otherwise the stream's TTY-ness, so files, pipes, and CI logs stay
  plain. Verified by a test asserting `stripAnsi(colored) === plain`.
- **The verdict leads**, with a glyph and accent per assessment (`✔` green
  expected, `✔` cyan candidate-fix, `●` cyan informational, `✖` red
  alert/setup-failed, `▲` yellow inconclusive) so the eye lands on whether
  to care before reading a word. Outcome and assessment collapse to one
  token when identical (`setup-failed`, not `setup-failed · setup-failed`).
- **Supporting detail recedes**: section headers, component names, target
  triple, timing, and report path in grey; failures in red, warnings
  (cleanup errors, workload timeout) in yellow.
- **Evidence is readable**: container ANSI stripped, the repeated
  `edge-1 | <timestamp>` compose prefix dropped (it cost ~55 columns and
  truncated the panic message — the stream is already named in the evidence
  header), indentation after the timestamp preserved so panic dumps keep
  their `left:`/`right:` alignment, scaffolding-only lines skipped, lines
  truncated to the terminal width, and the line that actually matched the
  pattern rendered bold against dim context.
- Report paths print relative to the working directory. Progress lines carry
  a dim timestamp.

Tokens the tests assert (`reproduced`, `not-reproduced`, `setup-failed`,
`repro rot`, `timing: total`, …) are unchanged, so this is presentation-only.
10 new tests in `tests/ass/report.test.ts` (169 total); `make lint` clean.
All five outcome renderings were eyeballed in a real terminal.

Fifth pass (final shape): multi-line values were rolling into the next key,
so the summary is now assembled from **blocks** rather than flat rows — a
block is a key plus its continuation lines, and the renderer inserts a
divider whenever either side of a boundary is multi-line: the same solid `─`
as the frame with a `┼` junction, running the full gutter on the left and a
15-character stub on the right that **fades out**, one interpolated step per character from the frame blue `rgb(95,175,255)` to a dark neutral `rgb(58,58,58)`, so it marks the boundary without a full-width
rule competing with the frame (a dashed `┄` variant was tried first and read as a different, weaker kind of line; grey returns here only as frame decoration, never as content). The fade is interpolated rather than hand-picked because the first attempt used palette codes and visibly brightened mid-rule: xterm `75→69→63` gains saturation, and `59` (#5f5f5f) → `245` (#8a8a8a) jumps 43 luminance points back up. Interpolating channels makes luminance fall monotonically by construction, which a test now asserts. Output is truecolor where `COLORTERM` advertises it, quantised to the xterm-256 cube/grey ramp otherwise, and two-tone on a 16-colour terminal. The dark endpoint assumes a dark terminal — a fade has to resolve toward some background, and there is no portable way to ask. Two weights of break carry the
hierarchy: the stub divides one key from the next, a bar-only row breaks
_within_ a key (the evidence excerpt).
Consecutive single-line rows (`target`/`timing`/`report`) stay grouped so the
footer does not sprawl and reads as one section. Inside the evidence block the
captured excerpt gets its own break after the headline, because it is a
quotation rather than more prose, and multiple evidence items are separated
from each other. Every break crosses the vertical rule rather than breaking
it, so the table stays one object top to bottom.

Fourth pass: keys and values are now visually distinct, which
the flat table lacked — an all-default-foreground block reads as an
undifferentiated wall. The summary is framed: keys **right-aligned** against a
vertical rule (`│`) that runs unbroken through section gaps and closes with
`┬`/`┴` joins, so the eye tracks one edge instead of scanning. The frame
(rule, keys, separators) is bright blue (`94` — plain blue `34` is unreadable
on dark terminals and grey reads muddy); values keep the terminal foreground;
colour beyond the frame stays reserved for what the run did (accent+glyph on
outcome/assessment, red setup failures, yellow cleanup errors and timeouts,
bold matched evidence line).

**Dependency question (D16), asked and answered:** no Node library fits this
shape. Bordered-table packages (`cli-table3`) model uniform grids, not a
definition list with key-inheriting continuation rows and nested evidence
blocks; `ink` is a React renderer, absurd for one-shot output. The only
defensible swap is `picocolors` for colour primitives, which would replace
roughly seven lines of TTY/`NO_COLOR`/`FORCE_COLOR` detection — below the D16
bar. Formatter plus style layer is ~180 lines with tests, dependency-free.

Keys are tinted one step down the same ramp the rule fades along
(`rgb(76,116,156)` against the frame's `rgb(95,175,255)` — measurably lower
luminance, asserted in a test rather than eyeballed), so a label reads as
structure that is related to the frame but quieter than it, and the value
beside it stays the brightest thing on the row. `tint()` degrades the same way
the fade does: truecolor, then the 256 cube, then plain blue `34` against the
frame's bright `94` on a 16-colour terminal, then nothing when colour is off.

Third pass: **no grey anywhere.** The summary is a two-column
table — one key gutter (`outcome`/`assessment`/`verdict`/`components`/
`evidence`/`target`/`timing`/`report`) sized to the longest key, values
aligned against it, continuation rows leaving the gutter blank and inheriting
their key. Alignment does the work grey was doing, so every section has the
same predictable shape and nothing needs to be dimmed to stay out of the way.
Colour is now purely semantic and rare: the accent + glyph on the outcome and
assessment kind, red for setup failures, yellow for cleanup errors and
workload timeouts, bold for the evidence line that matched. Components and
evidence nest a second aligned column inside the value column. The evidence
row puts the match count _before_ the pattern spec, because on a narrow
terminal the spec is what you can afford to lose, not "did we capture
anything". `grey` was dropped from the palette and the progress timestamp is
plain, so the decision cannot quietly regress.

Second pass after driver review: the first cut over-used grey — when most of
the block is grey, grey stops meaning "secondary". Hierarchy now comes from
layout (indentation, alignment, blank lines) and grey is reserved for the one
genuinely skippable block: the rule, the evidence pattern spec, and the
footer. Section labels, component names, and the verdict reason went back to
plain; evidence context is plain with only the matched line bold (dimming the
context made the whole block recede). The pre-run banner also duplicated the
summary header — it is now a single line (`WAX-600  env: … · mode: … ·
lifecycle: …`) with the title carried only by the summary, which is what
survives a long run's scrollback. The footer collapses target + timing onto
one line when it fits and splits when it does not; the report path is never
truncated, since a cut path cannot be copied.
