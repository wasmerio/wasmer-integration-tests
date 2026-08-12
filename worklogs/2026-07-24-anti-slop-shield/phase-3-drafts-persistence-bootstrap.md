# Phase 3 — Drafts, persistence, and bootstrap

**Status:** Complete (review 4 findings fixed 2026-08-07)  
**Worklog:** [Anti Slop Shield v1](README.md)

## Goal

Make experiments shareable, promote successful drafts without transcription, and provide a diagnosable first-run path.

## Specification

Wire the Phase 1 override surface (D12) into execution for both `try` and `run` — `--env`, `--cpus`, `--executor`, and `--component <name>=<selector>` with `--edge`/`--backend` sugar — while preserving the declaration as source of truth; a component override on a persisted run derives a floating-mode assessment (D6) and never rewrites the scenario. Persist the last successful resolved draft state needed by `ass promote`. Promotion resolves floating selectors to concrete pins, requires a verdict and a baseline or reasoned waiver (D10), stamps `lifecycle: open`, runs the baseline and records its evidence (or the waiver) in provenance, creates `repros/<slug>/README.md`, and moves the scenario only after validation.

Add `make ass` as a thin detector that reports the selected agent-harness launch command and attempts interactive handoff. Add `ass/bootstrap/SETUP.md` as the declarative setup contract and `ass doctor` as its convergence test. Doctor reports capabilities and remediation: Node 22+, pnpm install, Docker Compose v2 for local work, GitHub authentication for pinned release assets, Wasmer for raw workloads, and installed baseline engines (`python3`, `node`, `go`, `cargo`, …) per D10. Missing optional dependencies degrade capability rather than making every command unavailable.

## Integration contract

| Trigger                  | Collaborators                | Observable result                               | Required side effect             | Prohibited side effect                              |
| ------------------------ | ---------------------------- | ----------------------------------------------- | -------------------------------- | --------------------------------------------------- |
| `ass try` with overrides | draft loader                 | Effective run uses overrides                    | Record resolved successful state | Rewrite the draft declaration.                      |
| `ass run --component …`  | persisted loader, assessment | Floating-mode assessment reported               | Record overrides in the report   | Rewrite the persisted scenario.                     |
| `ass promote`            | draft state and resolver     | Pinned persisted scenario and provenance README | Move validated artifact          | Promote an unresolved or verdict-less draft.        |
| `make ass`               | local agent harness          | Legible launch command or manual fallback       | Detect only                      | Install tools or alter system configuration itself. |
| `ass doctor`             | local toolchain              | Per-capability pass/fail and remediation        | none                             | Expose secrets.                                     |

## Acceptance criteria

- [x] Checked-in drafts run with overrides without source mutation; persisted runs with component overrides report floating-mode assessments. _Evidence: `tests/ass/cli.test.ts` "try runs drafts from experiments/ only" (a draft executes and reports `kind: draft`), "no run or override rewrites a scenario declaration" (byte-for-byte snapshot of `experiments/` + `repros/` across eight try/run/override/promote invocations), "component override switches a persisted run to floating mode"; `tests/ass/promote.test.ts` "a draft run never alerts, however quiet it is" (the declaration that is repro rot under `ass run` is exit 0 under `ass try`)._
- [x] Promotion is deterministic from successful resolved state and rejects invalid drafts without moving files. _Evidence: `tests/ass/promote.test.ts` — "pins the resolved selector, stamps the lifecycle, keeps the comments" (the pin written is exactly `TryState.pins`), "a component overridden at try time (R4-01)" (four tests: an override is pinned to what it resolved and the declaration it replaced does not survive; an override resolving to something unpinnable is refused; an untouched pinned component is still kept verbatim), "the promoted scenario runs under strict validation" (the artifact is loadable by `ass run` as `mode: pinned`), and six refusals (no recorded run, edited declaration, non-reproducing run, no verdict, no baseline, unpinnable selector, pre-existing target) each asserting the target directory does not exist and the draft is untouched. Proven end-to-end against the real local platform on 2026-08-07: a throwaway draft ran (`reproduced`, exit 0), recorded pins, and promoted — `resolve_prod` became `github-release:wasmerio/edge:v2026-08-06_0_57c6d52_dev1:edge` in the persisted declaration, comments intact (see "The round trip, run for real")._
- [x] Generated provenance identifies source draft, resolved fixture versions, target, workload, and verdict. _Evidence: `tests/ass/promote.test.ts` "the generated README carries the promotion's provenance" asserts all five plus the D10 baseline disposition and the run command; "the provenance names the override rather than claiming the draft's pin" asserts the origin column attributes an overridden component to `--component <name>=<selector>` and never to the declaration._
- [x] `make ass` and `ass doctor` have deterministic tests with harness/tool probes faked at their process boundary. _Evidence: `tests/ass/bootstrap.test.ts` drives the real `detect.sh` as a process against a fake `HOME`/`PATH` (detection, recency ranking, fall-through to an installed harness, the launch itself, launch failure vs. session exit code, both no-harness fallbacks); `tests/ass/doctor.test.ts` fakes every toolchain probe (13 tests) and drives `ass doctor` through the CLI seam._

## Error coverage

| Condition                                  | Expected outcome                                                                              | Test                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| No successful try state                    | Promotion explains prerequisite; nothing moves                                                | `tests/ass/promote.test.ts` "a draft with no recorded run explains the prerequisite"                    |
| Recorded run does not match the draft      | Promotion refuses: the pins would describe a different experiment                             | `tests/ass/promote.test.ts` "a draft edited since its run is refused"                                   |
| Last run did not reproduce                 | Promotion refuses, naming the recorded outcome                                                | `tests/ass/promote.test.ts` "a run that did not reproduce is not promotable"                            |
| Draft has no verdict / no baseline         | Promotion refuses, naming the missing block (cause before symptom; D10)                       | `tests/ass/promote.test.ts` "a verdict-less draft…", "a draft without a baseline or waiver… (D10)"      |
| Unresolvable floating selector             | Promotion fails before move, naming the component and why the value is not a pin              | `tests/ass/promote.test.ts` "a selector that resolved to something unpinnable fails before the move"    |
| Overridden component resolved to a non-pin | Promotion refuses, naming the override it ran on rather than the declaration                  | `tests/ass/promote.test.ts` "an override that resolved to something unpinnable is refused"              |
| Write fails part-way through the move      | Partial copy removed; draft and try state survive for the retry                               | `tests/ass/promote.test.ts` "a failure mid-move leaves no half-built repro"                             |
| Target repro already exists                | Promotion refuses rather than overwriting a persisted reproduction                            | `tests/ass/promote.test.ts` "promotion never overwrites an existing repro"                              |
| Dependencies not installed                 | The entry point states it and points at `make setup`, exit 1 — not a bare exec failure        | `tests/ass/bootstrap.test.ts` "a tree with no node_modules gets doctor's own remediation"               |
| Harness absent or launch fails             | Printed manual command and SETUP quick path                                                   | `tests/ass/bootstrap.test.ts` "a launch that cannot run…", "no harness at all…", "state present but…"   |
| Docker absent                              | Doctor marks the local capability unavailable and says it costs every runnable target, exit 0 | `tests/ass/doctor.test.ts` "Docker absent removes the local target and nothing else"                    |
| Required Node/pnpm/install absent          | Doctor exits 1 with remediation per capability                                                | `tests/ass/doctor.test.ts` "a missing Node or pnpm fails with remediation", "uninstalled dependencies…" |

## Implementation notes

_Session: Phase 3 implementation, 2026-08-07 (Claude Code)._ Deltas from the
specification:

- **`ass try` executes through the same engine as `ass run`.** `runCommand`
  took a `ScenarioKind`; nothing else about the run path forked. What a draft
  changes is the _assessment_, not the mechanism.
- **Drafts never alert, and a verdict-less draft is not a failure.**
  `assess()` gained a draft dimension (D6 stays the rule for persisted
  scenarios). An experiment that stopped triggering is a fact about the
  experiment, not repro rot — mapping it to `alert`/exit 2 would train people
  to ignore the code that matters on `repros/`. A draft with no verdict ends
  `inconclusive` (honest: nothing was proven) with assessment `informational`
  and exit 0, and says so in the summary.
- **`ResolvedState` gained `pins`, distinct from `components`.** They answer
  different questions: `components` is the version a human reads
  (`stackmachine:v2026-08-03_1_c3252ee`), `pins` is a selector that can be
  _declared again_. The local platform already records both —
  `EDGE_RESOLVED` and `BACKEND_IMAGE_SOURCE` in `resolved.env` are selectors
  by construction (`resolve.py` builds them as `github-release:…`), and
  `BACKEND_IMAGE_REF` is a bare image ref. Promotion classifies whatever it
  gets rather than trusting it: a mutable docker tag or a `path:` build is
  refused with the reason, so the "pinned" guarantee stays real.
- **Try state lives in `.ass/state/<slug>.json`, gitignored.** It is one
  machine's observation, not a committed artifact. It carries a **digest of
  the declaration that produced it**, and promotion refuses a record whose
  scenario has since been edited — otherwise the pins would describe a
  different experiment than the file being promoted. Records survive a
  not-reproduced run too, so the refusal can say what the last run actually
  did instead of "no state".
- **Promotion is a text edit, not a re-serialization.** Round-tripping YAML
  through js-yaml would drop exactly the comments that explain why a pin is
  what it is (`# the exact failing releases from the original CI run`). So
  `rewriteComponents`/`stampLifecycle` patch the specific lines and preserve
  everything else, then the result is **re-parsed under persisted validation
  and checked to say what was intended** before anything moves. A rewrite
  that cannot be verified refuses and tells the developer to pin by hand;
  nothing is half-moved.
- **Refusal order is cause before symptom.** A verdict-less draft can never
  record `reproduced`, so checking the outcome first would report the
  symptom. Declaration gaps (no verdict, no baseline/waiver) are reported
  first, then the run outcome.
- **Baseline _execution_ at promote stays in Phase 4.** The phase text says
  promotion "runs the baseline and records its evidence"; D10's own
  resolution column puts doctor/promote _enforcement_ in Phase 3 and
  execution in Phase 4, and the engine still gates non-waived baselines
  (`gateUnimplemented`). Promotion therefore enforces that a baseline or a
  reasoned waiver exists and records its disposition in the provenance
  README, marked as Phase 4 for execution.
- **`make ass` is POSIX sh, not Node.** It runs before Node, pnpm or python
  exist — that is the whole point of bootstrap — so it can depend on none of
  them. It detects platform hints and the most recently used agent harness
  (state dirs ranked by `ls -dt`, first one whose command is on PATH), prints
  the launch command _before_ running it, and hands off. It installs nothing.
  Exit codes 126/127 are treated as launch failure (fallback printed); any
  other code is the agent session's own result and is passed through
  untouched. `ASS_BOOTSTRAP_DRY_RUN` and `ASS_BOOTSTRAP_HARNESSES` are test
  seams, so the tests drive the real script as a process against a fake
  `HOME` and `PATH` and never touch the developer's machine.
- **Doctor's probes go through one injected boundary.** Everything it knows
  comes from `probe(argv)`, `nodeVersion` and `exists`, so the whole table is
  deterministic in tests, and `CliOptions.doctor` carries the same seam
  through the CLI. Required: node 22+, pnpm, `node_modules`. Degrading:
  python3, docker compose v2, `gh` auth, `wasmer`, and the `go`/`cargo`
  baseline engines — each states what it costs (`unavailable: …`) and how to
  fix it, with the install hint following the machine (nix when present,
  brew on darwin, apt when found).
- **`experiments/README.md`** now exists so the boundary the loader has
  searched since Phase 1 is documented where a developer will find it.
- **`.prettierignore`**: `ass/bootstrap/detect.sh` — Prettier has no shell
  parser and errors out rather than skipping, which would make `make lint`
  unrunnable.

### The round trip, run for real

The fakes prove the seams; only the real platform proves the assumption that
`resolved.env` contains selectors worth pinning. A throwaway draft
(`experiments/ass-smoke/`, `edge: resolve_prod` + a pinned backend, verdict
matching any edge output — it proves the harness, not a bug) went through the
whole loop on 2026-08-07 and was deleted afterwards, since a scenario that
"reproduces" nothing does not belong in the corpus:

- `./bin/ass try ass-smoke` → `reproduced` / `informational` / **exit 0**,
  3m52s (setup 3m19s, workload 4.0s, cleanup 29.6s), run dir
  `20260807T095226Z-a9c5cb0`.
- `.ass/state/ass-smoke.json` recorded
  `pins.edge = github-release:wasmerio/edge:v2026-08-06_0_57c6d52_dev1:edge`
  — `resolve_prod` resolved to a concrete release — and
  `pins.backend = github-release:…v2026-07-15_2_9a6c3d4:*image*.tar*`, the
  archive selector, **not** the per-run image tag
  `local-platform-backend:wit_20260807t095226z_a9c5cb0` that `components`
  carries. That divergence is the whole reason `pins` exists.
- `./bin/ass promote ass-smoke` → exit 0: edge pinned to the resolved
  release, backend reported as `kept (already pinned)`, `lifecycle: {state:
open}` stamped under `title:`, **both YAML comments preserved verbatim**,
  provenance README generated, directory moved, try-state cleared, and
  `ass list` stopped marking the slug experimental.
- `local.env` and the compose file were byte-identical afterwards
  (`git status` clean), and the stack was torn down.

Two environmental notes from the attempts that preceded it, both surfaced by
the summary rather than by log archaeology (the addendum-7 diagnosis work
paying off): an orphaned stack from an earlier session held port 18000, and
on a port-shifted retry boot-time precompilation failed to fetch a seeded
package through the relocated backend port. The second is a local-platform
limitation around non-default ports, unrelated to this phase — noted for
whoever next runs two stacks side by side.

One fix came out of the real run: the provenance README recorded the report
path absolutely (a fact about the machine that ran it), now relative to the
repository when it is inside it.

## Review findings (review 4, 2026-08-07)

Gates re-run independently: `npx jest tests/ass` — 13 suites, **214** tests
pass; `make lint` — clean (fmt-check, `tsc --noEmit`, eslint, and the 36
Python tests). The real end-to-end round trip was **not** re-run at the
driver's request (a concurrent local stack would collide); everything below
was established by reading the code and by driving the real seams under the
fake harness.

### Findings

- [x] **R4-01 (Major) — promotion writes a component the recorded run never
      used.** _Fixed 2026-08-07._ `ass/scenario/promote.ts:176` (`resolvePins`) classifies against
      the **declared** selector: any component whose declaration is already
      pinned goes to `kept` and is copied through verbatim. It never consults
      `state.selectors`, which is exactly the field that records the effective
      selector after `--component`/`--edge`/`--backend` overrides
      (`ass/engine/state.ts:25`, written from `effective.components` at
      `ass/engine/runner.ts:540`).

  _Failure scenario, reproduced under the fake harness._ A draft declares
  `edge: github-release:wasmerio/edge:v2026-07-16_1_fcdd9c4_dev1:edge`. The
  developer runs
  `ass try wax-998 --edge github-release:wasmerio/edge:v2026-08-05_1_419b336_dev1:edge`;
  the run reproduces and records
  `selectors.edge = pins.edge = …v2026-08-05_1_419b336_dev1…`. `ass promote
wax-998` then exits **0**, prints `kept edge (already pinned)`, writes
  `…v2026-07-16_1_fcdd9c4_dev1…` into `repros/wax-998/scenario.yaml`, and
  generates a README whose table says `| edge | …v2026-07-16… | declared
pinned in the draft |` under the heading `Outcome: reproduced`, closing with
  "The reproduction above is what the recorded run observed on the pinned
  selectors." The 07-16 build was never booted.

  Three consequences, one per acceptance criterion: the provenance is false
  (AC-3); the artifact is not derived from the successful resolved state
  (AC-2); and the promoted scenario is all-pinned, so the next `ass run` is
  **pinned mode** — if 07-16 does not reproduce, `assess` returns `alert`,
  exit 2 (`ass/engine/assessment.ts:110`). That is manufactured repro rot on a
  reproduction nobody ever proved, on the one code path the whole lifecycle
  model exists to make trustworthy.

  Fix: treat a declared-pinned component that was overridden like the floating
  case — pin it from `state.pins[name]` through the same
  `classifySelector` gate, and refuse (naming the override) when the result is
  not a pin. The provenance row should then read "resolved from the
  `--component` override" rather than "declared pinned in the draft". Nothing
  new needs recording; `state.selectors` already carries it. A regression test
  belongs beside the six existing refusals in `tests/ass/promote.test.ts` —
  the current suite never runs `try` with an override before promoting.

- [x] **R4-02 (Minor) — `ass doctor` cannot run in the state it exists to
      diagnose.** `bin/ass:5` is `exec …/node_modules/.bin/tsx …`. On a machine
      that has not installed dependencies this is
      `exec: ./bin/../node_modules/.bin/tsx: not found`, **exit 127**, with no
      diagnostic (verified against a stripped tree). But
      `ass/bootstrap/SETUP.md:8-12` makes doctor the _first_ instruction ("The
      convergence test is `pnpm ass doctor` … Run it first — it tells you
      exactly what is missing"), and `ass/bootstrap/detect.sh:18` hands the
      agent the same ordering. So the phase Goal's "diagnosable first-run path"
      is not diagnosable at first run, and doctor's own `dependencies
installed` capability (`ass/bootstrap/doctor.ts:119`) is unreachable in
      practice — any machine that can execute doctor already passes it, which
      is why `tests/ass/doctor.test.ts:107` can only assert it through the
      injected `exists` seam.

  Fix: have `bin/ass` test for `node_modules/.bin/tsx` and print doctor's own
  remediation (`make setup (runs pnpm install)`) on the miss, so the required
  capability reports itself; or reorder SETUP.md and the `detect.sh` prompt to
  `make setup` → `ass doctor`. `detect.sh`'s no-harness fallback
  (`quick_path`) already gets this ordering right, which makes the
  inconsistency the tell.

- [x] **R4-03 (Note) — doctor's degrade wording promises a target that does
      not exist yet.** `ass/bootstrap/doctor.ts:139` and `:155` degrade
      python3 and docker compose with "local-target runs … remote targets stay
      usable", and the error-coverage table above says "remote capability
      remains usable, exit 0". Remote execution is refused until Phase 5
      (`ass/engine/runner.ts:244`). A machine with neither Docker nor Python
      exits 0 as "ready (2 capabilities degraded)" while _every_ `ass try` and
      `ass run` is impossible. The claim is forward-looking, not currently
      true; either say so in the degrade string or make the row honest.

- [x] **R4-04 (Note) — stale test count.** The README status board says "221
      tests"; the session-journal entry and the actual run both say 214.

- [x] **R4-05 (Note) — the move itself has no rollback.**
      `ass/scenario/promote.ts:341-355` is `mkdir` → `cpSync` →
      `writeFileSync(scenario.yaml)` → `writeFileSync(README.md)` →
      `rmSync(draft)`. A failure anywhere in that window leaves
      `repros/<slug>/` half-built _and_ the draft in place; the next promote
      then refuses with "already exists" and the developer must clean up by
      hand. The window is small because all validation precedes it, but the
      implementation notes claim "nothing is half-moved". Copy to a temp
      sibling and rename, or unwind the target on error.

### Fix round 4 (2026-08-07)

All five resolved; 221 tests pass, `make fmt` + `make lint` clean.

- **R4-01.** `resolvePins` now decides from the **effective** selector
  (`state.selectors[name] ?? declared`), not the declaration. A component the
  run overrode takes the floating path — pinned from `state.pins[name]`
  through the same `classifySelector` gate — and only an untouched pinned
  declaration is `kept`. The refusal messages branch on the cause so an
  override reads as "ran on the override … rather than its declared …". The
  provenance origin column and the `ass promote` output both name the
  override and the declaration it replaced, so a promotion that silently
  changes what the scenario pins cannot happen quietly. `PromoteResult` gained
  `overridden` to carry it.
- **R4-02.** `bin/ass` checks for `node_modules/.bin/tsx` and, on the miss,
  prints doctor's own remediation (`make setup`) and exits 1 instead of
  failing as a bare `exec: … not found`. Verified against a stripped tree and
  covered by two process-level tests (the missing-runner message, and that a
  present runner still receives `main.ts` plus the arguments untouched).
  SETUP.md now says which single item may need fixing before doctor can
  report the rest.
- **R4-03.** The Docker and Python degrade strings say the capability costs
  "every target ass can currently run"; SETUP.md warns that doctor's exit 0
  is not the same as "can run a scenario" until remote targeting lands.
- **R4-04.** Test count corrected on the board (now 221 after this round).
- **R4-05.** The copy, both writes, and the draft-notes read sit inside one
  try/catch that removes the target on failure and raises a `PromoteError`;
  the target's existence is re-checked immediately before the copy so the
  unwind can only ever remove a directory that call created.

### Verified good

- **The no-mutation invariant holds.** `tests/ass/cli.test.ts:178` snapshots
  `experiments/` + `repros/` byte-for-byte across eight invocations including
  a refused `promote`. Traced independently through `mergeEffectiveFixtures`
  (overrides are merged into a fresh object, never written back) and through
  every `PromoteError` throw site — all six refusals precede the first
  filesystem write.
- **The rewrite cannot land on the wrong anchor.** `rewriteComponents`
  anchors on the first `components:` key at any indent, not on
  `fixtures.components` specifically, but a mis-targeted rewrite cannot
  escape: `promote.ts:325-332` re-parses under persisted validation and
  asserts `promoted.fixtures.components[name] === selector` before anything
  moves. A decoy `components:` key under `meta:` is rejected earlier still by
  the strict schema.
- **`stampLifecycle` survives nested `meta` blocks in both orderings.**
  Probed `links:` before `title:` and after; the insertion lands after
  `title:` in both and the result parses — the loop's `entry[1].length === 0`
  break only fires on a genuinely top-level key.
- **`detect.sh` is tested at a real boundary.** `tests/ass/bootstrap.test.ts`
  spawns the actual script under `sh` with a fake `HOME` and `PATH`
  (`:67-78`); the recency ranking, fall-through, launch, 126/127-vs-session
  exit split, and both no-harness fallbacks are all exercised as processes,
  not mocked.
- **The secrets prohibition holds.** `defaultProbe` merges stderr into
  `stdout`, but the `github authenticated` row (`doctor.ts:161-170`) reports
  fixed strings rather than `gh auth status` output, so nothing from an
  authenticated session reaches the terminal.
- **The R3-02 class does not regress.** `recordTryState` failure is caught and
  downgraded to a warning (`runner.ts:544-552`); a scratch-state write error
  never costs the run its report or its D15 exit code.
- **Drafts never alert on any path.** Every branch of `assessDraft`
  (`assessment.ts:52-77`) returns `informational` or `inconclusive` — exit 0
  or 3, never 2 — and `setup-failed` is intercepted before the draft
  dimension is consulted.
