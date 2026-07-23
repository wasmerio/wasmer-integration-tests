# Phase 1 — Foundation and decisions

**Status:** Complete  
**Worklog:** [Anti Slop Shield v1](README.md)

## Goal

Confirm the v1 architecture and provide a validated scenario schema, loader, and safe local CLI foundation.

## Specification

All gating decisions are resolved (D1/D6/D7/D10/D11 on 2026-07-30; D2/D3/D8 plus the D12–D15 additions on 2026-08-04); the architecture below is implementation contract. Create the `ass/` package with a CLI supporting `list`, `try`, `run`, `promote`, and `doctor`, plus a Zod-backed scenario loader. Define the three top-level sections: `fixtures`, `load`, and `verdict`. A load may declare several executor profiles but names exactly one active default; scenario metadata includes id, title, provenance links, and the typed `lifecycle` discriminated union (`open`; `fixed` requiring `fixed_in`/`fixed_at`/`evidence`, with `fixed_in` keys validated as a subset of `fixtures.components`; `retired` requiring `superseded_by`). Verdict predicates sit under explicit `any`/`all` combinators, are classed executor- or environment-observable, and an engine-owned capability table decides per-target evaluability (D7); the loader/engine seam exposes preflight so an unevaluable predicate fails before fixture resolution. Run outcomes are `reproduced`, `not-reproduced`, `inconclusive`, and `setup-failed`; the optional `not_reproduced_when` block and named `controls` with expected outcomes are part of the schema (D8). `verdict.baseline` — native engine (`python3` | `node` | `go` | `cargo` | `binary` + `command:`), entry point, expected outcome defaulting to `not-reproduced` — is required on persisted scenarios unless explicitly waived with a reason (D10); drafts may omit it. `verdict.probe` declares the D11 marker-line contract (`ASS-VERDICT:` grammar, exactly-once semantics) with a `channels:` list of typed objects — an open union starting with `{type: log, stream: …}` and `{type: http, match: body}` — as the preferred alternative to hand-written `output_matches`/`log_matches`, which remain for non-conforming workloads. The capability table records app instance streams as evaluable on every environment (Vector→Loki funnel) and platform process streams as local-only. Implement case-insensitive slug lookup and strict directory boundaries described in the README. The CLI defines the shared override surface (D12) — `--env`, `--cpus`, `--executor`, and `--component <name>=<selector>`, with `--edge`/`--backend` as sugar — parsed and validated here (an override naming an undeclared component is a CLI error listing the declared ones); execution wiring lands in Phase 3. App and probe fixture entries accept a `config:` block (open object; first member `max_instances`, a positive integer) that targets must honor or fail preflight (D13). The assessment's exit-code enumeration is fixed (D15): `0` expected/informational, `1` usage/validation/preflight error, `2` alerting assessment, `3` inconclusive, `4` setup-failed.

Define common `ResolvedState` and `RunOutcome` types now, but defer concrete fixture and executor implementations to later phases. The schema must distinguish draft permissiveness from persisted-scenario requirements: drafts may float selectors, omit verdict, and omit lifecycle (defaulting to `open`); persisted scenarios require pinned selectors, a verdict, and valid lifecycle. The assessment derivation (lifecycle × pinned/floating mode → expected/alert, D6) together with its D15 exit-code mapping is a pure function defined and unit-tested here even though alerting wires up in Phase 6. Keep the package location and Artillery embedding decision visible in the decision log.

## Integration contract

| Trigger                          | Collaborators         | Observable result                                    | Required side effect    | Prohibited side effect                  |
| -------------------------------- | --------------------- | ---------------------------------------------------- | ----------------------- | --------------------------------------- |
| `ass list`                       | scenario directories  | Union of known slugs, experimental entries marked    | none                    | No scenario execution.                  |
| `ass try WAX-600`                | `experiments/wax-600` | Draft is loaded using draft validation               | none                    | Must not search `repros/`.              |
| `ass run WAX-600`                | `repros/wax-600`      | Persisted scenario is loaded using strict validation | none                    | Must not search `experiments/`.         |
| Invalid or ambiguous declaration | schema/loader         | Actionable validation error                          | nonzero command outcome | No fixture mutation or workload launch. |

## Acceptance criteria

- [x] All gating decisions (D2, D3, D8, D12–D15) are recorded as resolved in `README.md` with no reopening finding. _Evidence: README decision table (D2/D3/D8, D12–D15 all Accepted 2026-08-04); feedback index empty._
- [x] Valid draft and persisted declarations load into typed scenario data; malformed sections, an ambiguous active executor, and invalid lifecycle variants are rejected. _Evidence: `tests/ass/schema.test.ts` (draft/persisted, load-profiles, and lifecycle describe blocks)._
- [x] The assessment function covers all lifecycle × mode combinations and the D15 exit-code enumeration with unit tests; verdict preflight rejects predicates unevaluable on the chosen target. _Evidence: `tests/ass/assessment.test.ts` (full 3×2×4 matrix); `tests/ass/preflight.test.ts`._
- [x] `--component` overrides parse and validate against declared components; fixture `config` blocks parse and reject non-positive `max_instances`. _Evidence: `tests/ass/cli.test.ts` ("override surface (D12)"); `tests/ass/schema.test.ts` ("fixture config (D13)")._
- [x] `list`, `try`, and `run` implement case-insensitive lookup and never cross the draft/persisted boundary. _Evidence: `tests/ass/loader.test.ts`; `tests/ass/cli.test.ts` ("command-to-loader boundary selection")._
- [x] Parser and CLI behavior have focused tests; a local-platform boundary test covers command-to-loader selection without mutating fixtures. _Evidence: `tests/ass/` wired into the `general` CI suite (`.github/integration-test-suites.json`), which runs on the local-platform PR pipeline; `tests/ass/cli.test.ts` "no command mutates the scenario directories" snapshots the whole tree before/after every command._

## Error coverage

| Condition                                                                           | Expected outcome                                                              | Test           |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------- |
| Unknown slug                                                                        | Actionable not-found error naming the searched boundary                       | CLI test       |
| Case-colliding directories                                                          | Deterministic ambiguity error                                                 | loader test    |
| Missing `load` or no resolvable active executor                                     | Schema error                                                                  | schema test    |
| Persisted floating selector or missing verdict                                      | Strict-validation error                                                       | schema test    |
| Draft missing verdict                                                               | Loads successfully                                                            | schema test    |
| `fixed` without `fixed_in`/`evidence`, or `fixed_in` naming an undeclared component | Strict-validation error                                                       | schema test    |
| Persisted scenario with neither `baseline` nor a reasoned waiver                    | Strict-validation error                                                       | schema test    |
| `retired` without `superseded_by`                                                   | Strict-validation error                                                       | schema test    |
| `verdict.probe` with an unknown channel type                                        | Schema error naming the open-union members                                    | schema test    |
| Environment-observable predicate on a target with no adapter                        | Preflight failure naming predicate, stream, and target; no fixture resolution | preflight test |
| `--component` override naming an undeclared component                               | CLI error listing the declared components                                     | CLI test       |
| Unknown `config` key or non-positive `max_instances`                                | Schema error                                                                  | schema test    |
| Unknown `log_matches` stream (review 1, R1-01)                                      | Preflight failure on every target naming the known stream set                 | preflight test |
| Unrunnable or ambiguous `controls` entry (review 1, R1-02)                          | Schema error                                                                  | schema test    |
| Duplicate override flag (review 1, R1-04)                                           | CLI usage error                                                               | CLI test       |
| Control `executor:` naming an undeclared load profile (review 2, R2-02)             | Schema error naming the declared profiles                                     | schema test    |

## Implementation notes

**Session: Claude (branch `qa-634-anti-slop-shield-foundation`), 2026-08-04.**
Deltas from the specification; the layout follows design doc §5
(`ass/cli.ts` + `ass/main.ts` entry, `ass/scenario/{schema,loader,selectors}.ts`,
`ass/engine/{assessment,capabilities}.ts`, `ass/executors/contract.ts`).

- **CLI runtime:** the repo had no TS runner, and the house import style
  (extensionless relative imports) rules out Node's native type stripping, so
  `tsx` was added as a devDependency with a `pnpm ass …` script
  (`ass/main.ts` entry, kept separate so `ass/cli.ts` stays import-safe for
  tests). `runCli(argv, {cwd, io})` is the tested boundary.
- **Boundary test interpretation:** the "local-platform boundary test" is
  `tests/ass/cli.test.ts`, wired into the `general` CI suite so it executes on
  the local-platform PR pipeline. Commands run over disposable `mkdtemp`
  scenario trees; a full-tree content snapshot before/after every command
  proves no fixture mutation.
- **Selector classification** (`ass/scenario/selectors.ts`) grounds the
  pinned/floating split in the local-platform resolver grammar
  (`local-platform/localplatform/resolve.py`): `github-release:` (concrete
  tag), `artifact:`, `url:`, and `registry:…@=X` are pinned;
  `resolve_prod`/`resolve_dev`/`latest*`, `path:`, `github-artifact:`, and
  unpinned/ranged `registry:` float. Unrecognized forms classify as floating
  so strict validation rejects what it cannot prove immutable.
- **Retired assessments:** the design table covers only `open`/`fixed`; runs
  of a `retired` scenario assess as informational (exit 0) for definite
  outcomes in both modes — `inconclusive`/`setup-failed` still exit 3/4.
- **Active-executor inference:** a load with exactly one profile and no
  `executor:` resolves that profile as active; the ambiguity error requires
  two or more profiles without `executor:`.
- **Added refinements beyond the spec text:** a verdict must declare
  `reproduced_when:` and/or `probe:` (otherwise no run could end reproduced);
  probe `log` channels restrict `stream:` to `stdout|stderr` (probe-process
  streams); baseline `command:` is required for `engine: binary` and rejected
  otherwise.
- **Exit codes in Phase 1:** the CLI emits only `0`/`1` (D15's
  expected/usage-validation-preflight codes); the assessment codes `2`–`4`
  exist as the tested pure function and wire into `run` in Phase 3/6.
- Verification: `npx jest tests/ass` — 5 suites, 94 tests, all passing;
  `make lint` clean (prettier check, suite-coverage guard, `tsc --noEmit`,
  eslint incl. the new `./ass` path, local-platform python checks);
  `npx jest --listTests ./tests/general/ ./tests/utils/ ./tests/ass/` lists
  all five new files; `pnpm ass help|list|run <slug>` smoke-tested from the
  repo root.

## Review findings (review 1, 2026-08-04)

Independently verified: `npx jest tests/ass` (5 suites, 94 tests) and
`make lint` (prettier check, suite-coverage guard, `tsc --noEmit`, eslint,
local-platform python checks) re-run clean; `pnpm ass list` / `run` smoke-run
from the repo root. Every row of the error-coverage table traces to a real,
cited test. The D6×D15 assessment tests cover all 24 lifecycle × mode ×
outcome cells (12 definite + 12 dominance). The AC-6 CI claim holds end to
end: `code-qa.yaml` (`pull_request`) → `local-platform-suite.yaml` → matrix
read from `.github/integration-test-suites.json` → `general` suite runs
`./tests/ass/`. Boundary invariants confirmed in the loader (each command
resolves against exactly one root) and by the before/after tree snapshot; the
case-collision test degrades gracefully on case-insensitive filesystems while
Linux CI exercises it for real.

Findings — none reopen the phase (no AC or safety invariant breached). All
seven were resolved in the same-day fix round (see the resolution note under
each finding; journal entry "Fix round", 2026-08-04):

- [x] **R1-01 (Minor)** `ass/engine/capabilities.ts:39` — every stream outside
      `{app, stdout, stderr}` is presumed a platform process stream, and on
      `local` all streams are evaluable. A typo'd stream (`stream: egde`)
      passes preflight locally and, once Phase 4 evaluates verdicts, matches
      nothing → `not-reproduced` → for open×pinned an exit-2 "repro rot"
      alert instead of a validation error; on remote targets the error
      mislabels the typo a "platform process stream". Enumerate the known
      platform streams (`edge`, `backend`) and fail preflight on unrecognized
      names, listing the known set. Grazes AC-3's intent: a nonexistent
      stream is unevaluable on every target.
      _Fixed: `classifyLogStream` closes the universe (`app`/`stdout`/`stderr`
      app-instance, `edge`/`backend` platform-process, else unknown); an
      unknown stream now fails preflight on every target, naming the known
      set. Covered by the new preflight tests._
- [x] **R1-02 (Minor)** `ass/scenario/schema.ts:288` — `controls` entries skip
      the structural refinements `baseline` has: `{expect: reproduced}` with
      no runnable body, `command:` without `engine: binary`, and `engine:`
      plus `executor:` together all validate, deferring failure to Phase 4
      execution instead of load time. Mirror the baseline superRefine:
      exactly one of (`engine` + `entry`) or `executor`, `command` gated on
      `engine: binary`.
      _Fixed: `controlSchema` superRefine requires exactly one of a native
      run (`engine` + `entry`) or `executor:`, shares the binary↔command
      refinement with `baseline`, and rejects native-only fields on executor
      controls. Covered by the new "controls (D8)" schema tests._
- [x] **R1-03 (Minor)** `ass/cli.ts:243` — the catch-all maps every `Error`
      (including an internal `TypeError`) to exit 1 with only
      `error: <message>`, hiding the stack and misfiling internal faults as
      D15 usage/validation errors; the `PreflightError ||` clause is
      redundant since it extends `Error`. Catch the known families
      (`UsageError`, the loader errors, `PreflightError`, `ZodError`) and
      rethrow the rest.
      _Fixed: the catch now handles only `UsageError`, `PreflightError`, and
      the three loader error classes; anything else propagates with its
      stack._
- [x] **R1-04 (Note)** `ass/cli.ts:73` — duplicate `--env`/`--cpus` silently
      last-win while duplicate `--executor`/`--component` are errors; make
      the duplicate policy uniform.
      _Fixed: all flags parse as `multiple` and every duplicate single-valued
      flag is a usage error; tested for `--env`, `--cpus`, `--executor`._
- [x] **R1-05 (Note)** `ass/engine/capabilities.ts:49` — `isChannelEvaluable`
      is never consulted by `preflightVerdict`, so probe channels bypass
      preflight. Harmless while both union members evaluate everywhere, but
      the seam will not gate future channel types. Wire it in, or drop it
      until Phase 5 needs it.
      _Fixed: `preflightVerdict` now walks `verdict.probe.channels` through
      `isChannelEvaluable`; a total pass today, a real gate once the union
      grows._
- [x] **R1-06 (Note)** `tests/ass/helpers.ts:16` — `mkdtemp` roots are never
      removed; repeated local runs accumulate `ass-test-*` under the tmpdir.
      Track created roots and `rmSync` them in `afterAll`.
      _Fixed: helpers track created roots and remove them in `afterAll`._
- [x] **R1-07 (Note)** `ass/cli.ts:62` — flag parsing is hand-rolled even
      though Node 22 ships `node:util` `parseArgs` (zero-dependency: flags,
      values, repeated options), with `commander`/`yargs` as the usual
      third-party step up. Defensible at today's ~60-line surface, but
      decide before Phase 3 widens the CLI (`promote`, `doctor`, run wiring)
      rather than growing a bespoke parser; record the choice in the
      decision log either way.
      _Fixed: `parseOverrides` rewritten on `node:util` `parseArgs`
      (inline `--flag=value` and flag-like-value rejection come free);
      the choice is recorded as D16 (stdlib-first) in the decision log and
      AGENTS.md. Superseded the same day by the D16 amendment: the CLI now
      routes commands via `commander@^14` (subcommand dispatch is beyond
      `parseArgs`), with domain parsers, duplicate rejection, and the
      `runCli(argv, {cwd, io})` boundary unchanged — see the "CLI refactor"
      journal entry._

## Review findings (review 2, 2026-08-05)

Independently verified: `npx jest tests/ass` re-run — 5 suites, 109 tests
pass. `make lint` re-run — **fails at `fmt-check`** (R2-01), so the "CLI
refactor" journal claim "`make lint` clean" does not reproduce on the
current tree (tsc/eslint never even ran in that invocation).

All seven R1 fixes re-traced to code and tests; all hold, none regressed:

- **R1-01** `classifyLogStream` closes the universe; the `egde` typo fails
  preflight on all four targets naming the known set (preflight tests).
- **R1-02** `controlSchema` superRefine rejects all five unrunnable shapes
  ("controls (D8)" table test).
- **R1-03** the CLI catch handles exactly the five known error families
  (`CommanderError` exit code passthrough included); internal faults
  propagate with their stack.
- **R1-04** duplicate policy is uniform: `once`-wrapped single-valued
  flags, per-name `--component` rejection, and `--edge`/`--component
edge=` collisions are all usage errors, all tested.
- **R1-05** `preflightVerdict` walks `verdict.probe.channels` through
  `isChannelEvaluable`.
- **R1-06** test tmpdir roots are tracked and removed in `afterAll`.
- **R1-07/D16** `commander@^14` is in `package.json`, AGENTS.md carries the
  stdlib-first rule with the sanctioned exception, and the refactor
  preserved the `runCli(argv, {cwd, io}) → exitCode` boundary, every D15
  exit path, and the no-mutation tree-snapshot invariant.

Also verified: the `general` suite still runs `./tests/ass/`
(`.github/integration-test-suites.json`), Makefile `JSPATHS` covers
`./ass`, `ass/main.ts` propagates the exit code via `process.exitCode`,
and the Jest force-exit notice is pre-existing repo config
(`jest.config.js` `forceExit: true`), not a Phase 1 handle leak.

Findings — neither reopens the phase (no AC or safety invariant breached),
but R2-01 blocks commit/push until fixed:

- [x] **R2-01 (Minor)** `ass/cli.ts:41` — the file no longer satisfies
      Prettier (6 hunks: `{ }` → `{}` and continuation indents around the
      curried `once` helper and string concatenations), so `make lint`
      exits 1 at `fmt-check` and the CI **File format check** job would
      block the PR. The implementation notes' "make lint clean" claim is
      stale for the current tree. Run `make fmt`, confirm `make lint`
      passes end to end, and keep the gate green through commit
      (AGENTS.md: run before every commit/push).
      _Fixed (2026-08-05, Phase 2 session): `make fmt` run over the whole
      repo; `make lint` passes end to end (fmt-check, suite coverage, tsc,
      eslint, local-platform Python tests)._
- [x] **R2-02 (Minor)** `ass/scenario/schema.ts:295` — a control's
      `executor:` is never cross-validated against the declared `load`
      profiles, so `controls: {healthy: {executor: artillery-http,
expect: not-reproduced}}` with only a `jest:` profile validates and
      defers the failure to Phase 4 execution — the same
      load-time-vs-run-time gap class as R1-02, and inconsistent with the
      `--executor` override, which does list declared profiles on
      mismatch. Add the check to `crossValidate` (both modes), naming the
      declared profiles, plus an error-coverage row and a schema test.
      _Fixed (2026-08-05): `crossValidate` now rejects a control whose
      `executor:` has no matching load profile, in both modes, naming the
      declared profiles; error-coverage row added and covered by the new
      "controls (D8)" schema test (110 tests pass)._
