# Anti Slop Shield (ASS) — v1 design draft

|                          |                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status                   | Draft for review                                                                                                                                                                                                                                                                                                                                                |
| Driver                   | QA-634 — [Anti Slop Shield foundation and scenario model](https://linear.app/wasmer/issue/QA-634)                                                                                                                                                                                                                                                               |
| WARP                     | WARP-71 — [Anti Slop Shield (previously Bugfinder 3000)](https://linear.app/wasmer/issue/WARP-71)                                                                                                                                                                                                                                                               |
| Child tickets            | QA-635 (fixture/state manager), QA-636 (app backup/clone), QA-637 (executor contract), QA-638 (Artillery HTTP executor), QA-639 (Raw Wasmer executor), QA-640 (Edge/remote executor), QA-641 (reports/reference scenarios), QA-642 (pipeline workflow), QA-643 (Bugtopia qualification)                                                                         |
| Requirements input       | QA-541 — Artem's wishlist (declarative complex scenarios, HAR replay, same scenario across envs, pure-`wasmer run` execution)                                                                                                                                                                                                                                   |
| Exemplars                | [`repros/wax-600/`](../repros/wax-600) (declarative; superseded the retired `WAX-600-edge-wasix-cross-store-panic.sh`, commit `a1e41c1`), [`repros/wax-603/`](../repros/wax-603) (declarative; superseded the retired `WAX-603-wasix-timed-waits-never-expire.sh` in Phases 4–5, readable in branch history)                                                    |
| Existing building blocks | [`src/env.ts`](../src/env.ts) (`TestEnv`), [`local-platform/`](../local-platform) + [`docs/local-environment-v1.md`](./local-environment-v1.md), [`loadtest/wordpress/wordpress-load-test.mjs`](../loadtest/wordpress/wordpress-load-test.mjs) (ECO-403), [`tests/superpanics/`](../tests/superpanics), [`fixtures/`](../fixtures), [`flake.nix`](../flake.nix) |

This document is intended to be reviewable without prior context: every claim
links to the ticket or file it derives from.

## 1. Problem

Correctness suites catch functional regressions, but the expensive class of
Wasmer bugs lives elsewhere: behavior under load, environment-specific app
state, runtime pressure, Edge routing, and WASIX edge cases (WARP-71,
"Motivation"). Investigating one of these today means weeks of ad-hoc digging
across Edge → StackMachine → WASIX → runtime, and the reproduction knowledge
evaporates when the investigation ends.

The target workflow (WARP-71):

```text
production signature -> dev/Bugtopia reproduction -> local deterministic
reproduction -> regression validation
```

ASS is the tooling that makes each arrow cheap, and — critically — makes the
result **portable**: "here is the scenario; run it and you should see the same
failure signature."

## 2. What the exemplars already prove

Two hand-written repros predate the harness, and each proves a different half
of the design. Dissecting _why_ they work yields the requirement list for the
scenario model — each property below must survive the translation from
"hand-written bash" to "declarative scenario".

### 2.1 WAX-600 — pinned platform bug, environment-observed verdict

`repros/WAX-600-edge-wasix-cross-store-panic.sh` was a 58-line script that
reproduced a cross-Store WASIX panic that originally cost days to isolate. It
was retired in Phase 2 (D9) once [`repros/wax-600/`](../repros/wax-600) proved
equivalent on a real run; read it at commit `a1e41c1` for the pre-harness
shape. Its properties are the requirements this design has to meet:

| Property in the script                                                                                     | Generalized requirement                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKEND_PIN` / `EDGE_PIN` default to the exact failing release assets, overridable to `path:$HOME/…/edge` | **Version pinning with override.** A scenario names the component versions that exhibit the bug; a developer swaps in a local build to verify a fix without editing the scenario. |
| `CPUS=1` knob, cache wipe before run                                                                       | **Environment perturbation is part of the scenario.** Resource caps, cold caches, and similar triggers are declared, not tribal knowledge.                                        |
| `JEST_CMD` reuses an existing integration test as the workload                                             | **Existing tests are workloads.** The Jest suite is a library of known-good traffic generators; ASS drives them rather than re-implementing them.                                 |
| `grep "object used with the wrong context"` verdict block                                                  | **Machine-checkable failure signature.** A run ends in `REPRODUCED` / `NOT REPRODUCED`, not a wall of logs.                                                                       |
| Backup/trap/restore of the env file and compose file                                                       | **Runs are hermetic.** State mutation is owned by the harness, never left for the operator to undo.                                                                               |
| Header comment: Linear link, knobs, hivemind pointer                                                       | **Self-documentation.** A scenario carries its own provenance and usage.                                                                                                          |
| Runs from repo root with only `gh` + the standard toolchain                                                | **Near-zero setup.** One command from a fresh checkout.                                                                                                                           |

### 2.2 WAX-603 — self-verdicting probe, one workload everywhere

`repros/WAX-603-wasix-timed-waits-never-expire.sh` (retired in Phases 4–5;
readable in branch history) was a 65-line dispatcher over a probe directory
(now [`repros/wax-603/probe/`](../repros/wax-603/probe)).
It reproduces timed waits on Python threading primitives never expiring under
WASIX (`Event.wait(timeout)`, `Lock.acquire(timeout)`, `Condition.wait`,
`Queue.get` all hang forever). Where WAX-600 measures a pinned platform from
the outside, WAX-603 pushes in every direction the first exemplar didn't:

| Property in the script                                                          | Generalized requirement                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODE=local\|prod\|dev1\|native` — the same matrix runs everywhere              | **One workload, every environment.** The environment is a run input; the scenario is untouched across local `wasmer run`, dev Edge, and prod Edge — and the bug report gains "reproduced identically on all three". |
| probe prints `verdict: REPRODUCED …`; the script greps stdout / the HTTP body   | **Self-verdicting workloads.** A probe that reports its own result makes the verdict _executor-observable_ — evaluable on any target, including prod, with no environment log access required (§4).                 |
| `MODE=native` runs host `python3` as the passing control (exit 2)               | **Control runs.** A declared baseline that must NOT reproduce distinguishes "bug fixed" from "probe broken".                                                                                                        |
| exit `0` / `2` / `3` = reproduced / fixed / inconclusive                        | **`inconclusive` is a first-class outcome.** Unrecognized probe output is never silently reported as not-reproduced.                                                                                                |
| the matrix guards its own hangs with known-good primitives; ~25s worst case     | **Probes own their wall-clock bound.** A well-formed probe always terminates and reports; harness timeouts are a backstop whose firing means _inconclusive_, not a verdict.                                         |
| `PYTHON_PKG=python/python@3.13.5`, overridable to a local build                 | **Packages are pinnable components.** The artifact under test can be a registry package (here: the interpreter), not only Edge/backend releases; the same `path:` fix-verification override applies.                |
| one directory doubles as `wasmer run --volume` input and a deployable app       | **The scenario directory is the fixture.** The same probe dir is a runnable package and a deployable app — two executors, zero duplication.                                                                         |
| "Live deployments (temporary — delete when done)", hard-coded `app_id`s in yaml | **Deployed fixtures need lifecycle ownership.** Hand-deployed probe apps rot and leak; this is the anti-pattern ASS eliminates by deploying, reusing, and tearing down remote fixtures itself (QA-635/QA-640).      |

Together the two exemplars bracket the verdict spectrum: WAX-600's failure
signature lives in an environment log (the Edge panic), WAX-603's in the
workload's own output — exactly the environment-observable vs.
executor-observable split the predicate model in §4 encodes.

The design goal of v1 is: _everything the two scripts do by hand, the harness
does from declarations._

## 3. Two-phase operating model

ASS has two deliberately separate modes of use, distinguished by _where a
scenario lives_ and _what guarantees it carries_ — the CLI verbs mirror that
split directly:

```bash
ass list              # every known scenario, experimental ones marked
ass try <slug>        # Phase 1: resolve slug in experiments/, no pinning guarantees
ass run <slug>        # Phase 2: resolve slug in repros/, pinned, regression semantics
ass promote <slug>    # graduate a draft: pin floating versions, move to repros/
```

Slugs are case-insensitive (`ass run WAX-600` ≡ `ass run wax-600`);
directories are lowercase on disk. Both verbs execute the same engine over
the same file format — the difference is a way-of-work contract, not a
technical fork.

### Phase 1 — Experimentation (`experiments/`, drafts, `ass try`)

The developer (or an agent) is hunting. A draft is a directory of files —
`experiments/<slug>/scenario.toml` plus any payloads/fixtures it needs —
edited freely between `ass try <slug>` invocations. Drafts are relaxed:
component versions may float (`resolve_prod`, `latest`, a local `path:`),
the `verdict` block may be absent (the run just surfaces logs and metrics),
and nothing in `experiments/` is pinned for regression safety or picked up
by scheduled pipelines.

Drafts are **checked in**, unfinished or not. A half-working experiment is a
collaboration artifact: "checkout `sre-1234`, I can't quite get it to
trigger — can you try?" and the colleague is iterating with
`ass try sre-1234` seconds after pulling the branch. This is the in-progress
counterpart of the WARP-71 portability goal — the scenario is shareable
_before_ it works, not only after. The ingredients being combined:

- **Load shaping** — Artillery phases/arrival rates/ramps (the WARP-71 choice;
  already a devDependency, already exercised by
  [`loadtest/wordpress/wordpress-load-test.mjs`](../loadtest/wordpress/wordpress-load-test.mjs)).
- **Existing integration tests** — any `tests/**` Jest test invoked as a
  workload, exactly as the exemplar does via `LOCAL_TEST_COMMAND`.
- **Fixtures** — [`fixtures/`](../fixtures), `wasmopticon/` packages, or a
  cloned real app (QA-636, once BE-666 lands).
- **A target environment** — local platform, dev, Bugtopia, prod-capped
  (§6).

For quick iteration, `ass try` accepts CLI overrides on top of the draft
(`--env`, `--cpus 1`, and the generic `--component <name>=<selector>`;
`--edge path:…` / `--backend …` are sugar for the matching components), so a
knob sweep doesn't require an edit-save cycle; the draft file remains the
source of truth for what the experiment _is_. `ass run` shares the identical
override surface — overriding any component is exactly what puts a persisted
run in _floating_ mode (see "Lifecycle and assessment"), which is how fix
verification and regression watch work without touching the declaration.

### Phase 2 — Persistence (`repros/`, pinned, `ass run`)

When the loop converges on a reproduction, the draft is graduated with
`ass promote <slug>`: floating version selectors are resolved to concrete
pins (the exact failing release assets, exemplar-style), a `verdict` block
becomes mandatory, a provenance README is generated, and the directory moves
to `repros/<slug>/` for review and commit. The scenario is now the shareable
artifact WARP-71 asks for.

`ass run <slug>` executes a persisted scenario with regression semantics:
pinned versions by default, with **configurable versions of the affected
systems** as the deliberate escape hatch — this is how a fix gets verified
and how scheduled runs track moving targets:

```bash
ass run wax-600                                              # exact pinned repro
ass run wax-600 --edge path:$HOME/Projects/wasmer/edge/target/release/edge  # fix check
ass run wax-600 --edge resolve_prod --backend resolve_prod   # regression watch
```

Persisted scenarios are what the QA-642 pipeline workflow schedules, and —
once the bug is fixed — their workloads are promotable into the blocking
suite the way [`tests/superpanics/`](../tests/superpanics) tests were.

```text
Phase 1                                    Phase 2
experiments/wax-600/  (edit ⇄ ass try)  ──►  ass promote wax-600  ──►  repros/wax-600/scenario.toml
                                                                       repros/wax-600/README.md
                                                                       (reviewed, committed, scheduled)
```

`ass promote` is the agentic hook: the draft plus the last successful try's
resolved state already contain the working combination, so persisting a
reproduction is a review task, not a transcription task — the step humans
historically skip.

## 4. Scenario model (QA-634 core)

One file, three strictly separated sections, per the QA-634 acceptance
criteria ("fixture preparation completes before workload measurement begins"):

```toml
# repros/wax-600/scenario.toml
[meta]
id = "WAX-600"
title = "Edge wasix 759ca9d cross-Store panic under CPU starvation"
lifecycle = { state = "open" } # open | fixed | retired — see "Lifecycle and assessment"

[meta.links]
linear = "https://linear.app/wasmer/issue/WAX-600"
notes = "hivemind knowledge/04-codebases/edge/2026-07-16-wasix-759ca9d-cross-store-panic.md"

# fixtures: prepared BEFORE measurement (QA-635)
[fixtures.apps.victim]
source = "template:next-react-server-components"
# alternative sources: fixture:./fixtures/php/…, backup:ass-store://wp-cust-123@v2 (QA-636)

# version pins, any resolver selector the local platform accepts
[fixtures.components]
edge = "github-release:wasmerio/edge:v2026-07-16_1_fcdd9c4_dev1:edge"
backend = "github-release:wasmerio/backend:v2026-07-15_2_9a6c3d4:*image*.tar*"

# environment triggers, local-only section
[fixtures.perturbations]
edge = { cpus = 1, wipe_caches = ["compiler_cache", "webc_cache"] }

# load: measured workload, executed by ONE executor (QA-637/638/639/640)
[load]
executor = "jest" # jest | artillery-http | raw-wasmer

[load.jest]
spec = "tests/app/templates.test.ts"
testNamePattern = "next-react-server-components"

# verdict: machine-checkable outcome
[[verdict.reproduced_when]]
log_matches = { stream = "edge", pattern = "object used with the wrong context" }

# evidence retained either way (QA-641)
[[verdict.collect]]
edge_panic_context = { pattern = "panicked at", before = 1, after = 4 }
```

Section contracts:

- **`fixtures`** — everything that must exist before the clock starts:
  deployed apps, packages, pinned component versions, perturbations. Resolved
  by the state manager (QA-635); output is a bag of resolved variables
  (`{{ victim.url }}` etc.) handed to the executor. Failures here are _setup
  failures_, reported distinctly from load failures.
- **`load`** — exactly one executor block. Changing `executor` (or the target
  env at the CLI) must not require rewriting `fixtures` or `verdict` — this is
  the QA-637 contract. Executor-specific sub-keys are allowed; fixtures may
  declare executor compatibility (QA-635 AC). App and probe entries may
  declare `config:` (an open object; first member `max_instances`) which
  every target must honor or fail preflight — cross-request concurrency
  repros (locks, shared files) are structurally false-negative when requests
  spread across instances, so silent degradation is never acceptable here.
- **`verdict`** — predicates over executor output and environment logs,
  combined under an explicit `any:` / `all:`. A run ends in one of four
  outcomes: `reproduced`, `not-reproduced`, `inconclusive` (the workload ran
  but matched no expectation — WAX-603's exit 3; never silently folded into
  `not-reproduced`), or `setup-failed`. For load-quality scenarios the
  predicates are Artillery `ensure`-style thresholds instead of log patterns.

Predicates split into two classes, and evaluability follows from the class:
_executor-observable_ predicates are computed from `RunOutcome` (HTTP checks,
Artillery thresholds, `output_matches` on workload stdout / response bodies)
and evaluate on every target by construction; _environment-observable_
predicates (`log_matches` over log streams) evaluate where the engine has a
log adapter. Crucially, **app instance streams are readable everywhere**:
Edge ships instance stdout/stderr through Vector into Loki/ClickHouse — the
production pipeline whose semantics
[`local-platform/vector/vector.toml`](../local-platform/vector/vector.toml)
mirrors — and the backend serves them as app logs, so `stream: app` predicates
evaluate on local, dev, Bugtopia, and prod alike (and Vector accepts new
sources, so further streams are a funnel config away). Only _platform
process_ streams (`edge`, `backend` — the platform's own panics) are
local-only until dedicated adapters land (QA-640 follow-up). Evaluability is
a fact about the harness, not the scenario: an engine-owned capability table
maps `(predicate, stream, env)` to evaluable, and a predicate that is
unevaluable on the chosen target fails preflight _before fixtures resolve_ —
never silently skipped. When new adapters land, existing scenarios gain
evaluability without edits.

### Probe verdict contract

Self-verdicting probes get a fixed protocol instead of per-scenario grep
patterns, so any repro in any language encodes its result in one line:

```text
ASS-VERDICT: reproduced 4 primitive(s) broken
ASS-VERDICT: not-reproduced all primitives ok
ASS-VERDICT: inconclusive matrix incomplete
```

Fixed prefix, one of the three outcome tokens, optional free-text detail to
end of line. Emission rules: exactly one logical verdict — zero occurrences
⇒ `inconclusive` (the probe never judged), conflicting occurrences ⇒
`inconclusive` (repeated identical lines are tolerated; retries and tee'd
streams happen). In bash: `echo "ASS-VERDICT: reproduced …" >&2`. The same
line, emitted by the native engine run, is what makes the baseline
comparison mechanical. Scanning is windowed: markers count only between
workload start and a bounded post-load quiescence timeout — for process
capture the window is the process lifetime; on remote app-log channels the
window is what keeps a reused probe's previous run from contaminating
exactly-once evaluation.

The grammar is transport-agnostic; _where_ the harness listens is a typed
channel object, deliberately an open union so new transports are additive:

```toml
# built-in contract; replaces hand-written output_matches pairs
[verdict.probe]
channels = [
  { type = "log", stream = "stderr" }, # process capture locally; Vector→Loki app logs when deployed
  { type = "http", match = "body" },   # encoded in the served response
]
```

`type = "log"` covers both direct process capture (raw-wasmer, host-process,
jest) and deployed probes — instance stderr rides the Vector→Loki funnel and
is readable via app logs on every environment, so the stderr contract works
even on prod. `type = "http"` reads the probe's response body (a dedicated
verdict endpoint or header can join the union later; so can `type = "file"`
sidecars for rich per-check detail). Exit codes are deliberately **not** a
verdict channel: 8 bits with colonized semantics (`1` = generic exception,
`126`/`127` = exec failures, `128+n` = signals) that wrappers and shells
munge, and absent over HTTP — a probe dying of an unrelated error must not
accidentally claim "fixed". Instead the exit status is a consistency check:
a process that dies by signal or nonzero exit while its verdict line claims
`not-reproduced` yields `inconclusive` with the contradiction named.
Explicit `output_matches`/`log_matches` predicates remain for workloads that
cannot be modified to conform (wrapped third-party tests, WAX-600-style
platform signatures).

### Lifecycle and assessment

`meta.lifecycle` is a typed discriminated union (`open` | `fixed` |
`retired`) that makes the corpus auditable and gives scheduled runs their
alerting semantics. The verdict stays a _fact_; the **assessment** — what the
CLI exit code and the QA-642 pipeline alert on — is derived from
`lifecycle.state` × run mode (_pinned_: every component at its declared pin;
_floating_: any selector overridden):

| State   | Mode     | `reproduced`                 | `not-reproduced`                   |
| ------- | -------- | ---------------------------- | ---------------------------------- |
| `open`  | pinned   | expected — repro intact      | alert: repro rot                   |
| `open`  | floating | bug still present upstream   | candidate fix — suggest state flip |
| `fixed` | pinned   | expected — old versions fail | alert: repro/pin rot               |
| `fixed` | floating | **alert: regression**        | expected — fix holds               |

Exit codes are enumerated from the assessment, never the raw verdict: `0`
expected/informational (including the candidate-fix cell), `1`
usage/validation/preflight error, `2` alerting assessment, `3`
`inconclusive`, `4` `setup-failed` — the WAX-603 script's `0/2/3` convention
generalized to assessment semantics.

`fixed` cannot parse without `fixed_in:` (component → first known-good
version, validated as a subset of `fixtures.components`), `fixed_at:`, and
`evidence:`; an unversioned "fixed" claim is exactly the tribal knowledge ASS
exists to kill. `retired` requires `superseded_by:` pointing at the blocking
test that replaced the scenario (the §8 promotion path). `ass promote` always
stamps `open` — a draft cannot be born fixed.

For HTTP load, the `load` block is Artillery-native rather than a bespoke DSL
(WARP-71's explicit recommendation — don't invent a scenario format too
early):

```toml
[load]
executor = "artillery-http"

[load.artillery-http]
phases = [{ duration = 30, arrivalRate = 100 }]
scenarios = [{ flow = [{ get = { url = "{{ victim.url }}/a" } }] }]
```

`raw-wasmer` covers Artem's "pure wasmer" wishlist item (QA-541, QA-639):
the same fixture resolves to a local package/dir and the workload is
`wasmer run` invocations against a caller-selected binary — the last hop of
the investigation path before attaching a debugger.

### Self-verdicting probes (the WAX-603 shape)

The second exemplar translates into everything above plus three additions:
a probe fixture with two affordances, declared load _profiles_, and a
positive health signal. The full declaration:

```toml
# repros/wax-603/scenario.toml
[meta]
id = "WAX-603"
title = "WASIX timed waits on threading primitives never expire"
lifecycle = { state = "open" }

[meta.links]
linear = "https://linear.app/wasmer/issue/WAX-603"

[fixtures.probes.matrix]
source = "package:./probe" # repro.py + wasmer.toml, in the scenario dir
# {{ matrix.path }} always resolves; {{ matrix.url }} deploys the probe
# as an app on demand — harness-owned lifecycle, replacing WAX-603's
# hand-deployed "temporary — delete when done" apps

[fixtures.components]
python = "registry:python/python@=3.13.5" # package under test; path:… verifies a fix

# load: one ACTIVE profile per run; --executor selects among those declared
[load]
executor = "raw-wasmer" # default profile: `ass run wax-603`

[load.raw-wasmer] # the WAX-603 script's own invocation, declared
package = "{{ component.python }}" # the interpreter under test
volumes = { "{{ matrix.path }}" = "/work" }
args = ["/work/repro.py", "--once"]

[load.artillery-http] # `ass run wax-603 --env dev --executor artillery-http`
target = "{{ matrix.url }}"
scenarios = [{ flow = [{ get = { url = "/" } }] }]

# ASS-VERDICT contract (see "Probe verdict contract"); the probe emits one
# line; the harness listens on the declared channels
[verdict.probe]
channels = [
  { type = "log", stream = "stderr" }, # local wasmer run / host-process capture
  { type = "http", match = "body" },   # deployed-probe runs on Edge
]

# native-engine differential (WAX-603's MODE=native) — see below
[verdict.baseline]
engine = "python3" # host toolchain: python3 | node | go | cargo | binary
entry = ["repro.py", "--once"]
workdir = "{{ matrix.path }}"
expect = "not-reproduced" # violated => inconclusive (broken probe, not fixed bug)
```

Three rules fall out of it. **Profiles**: the load block may declare several
executor configurations, but exactly one is _active_ per run (`executor`
names the default, `--executor` selects) — this amends the earlier "exactly
one executor block" phrasing and is what makes MODE=local vs. MODE=dev1 a
re-run instead of a second scenario. A profile is named after the executor
that runs it; a profile that names one explicitly (`executor = "raw-wasmer"`
_inside_ the profile) may be called anything, which is how a scenario
declares two profiles of the same executor — the shape a "compare two guest
engine versions" control needs. **Package components**: a component that is
not `edge`/`backend` is a package under test rather than a platform pin. It
resolves to `{{ component.<name> }}` for the executor to consume and never
reaches docker compose, so `--component python=path:/my/build` verifies a
fix exactly as WAX-603's `PYTHON_PKG=` did — and a scenario that declares no
platform component, app or perturbation runs without booting the local stack
at all (~30s instead of ~6min). **Positive health proof**: WAX-600-style
scenarios treat absence of the panic as health, but a probe like WAX-603
must prove the matrix actually ran — the probe contract provides this for
free (an explicit `not-reproduced` token; no line at all ⇒ `inconclusive`,
likewise when the harness backstop timeout kills a probe that owns its own
wall-clock bound), and the optional `not_reproduced_when` block provides it
for workloads that cannot conform. **The baseline is the default proof shape**, elevated
from optional control to schema-level expectation — see below.

### The native baseline: differential proof by default

Nearly every real Wasmer bug is a compatibility divergence: some engine —
CPython, Node, the Go runtime, a Rust binary — behaves differently under
Wasmer/WASIX than it does natively. "The probe fails under Wasmer" only
becomes "this is a Wasmer bug" when the same probe demonstrably passes on
the native engine; WAX-603's `MODE=native` is that proof, and it is the
shape ~99% of scenarios should carry. The schema therefore treats the
baseline as the default requirement, not an optional extra:

- **`verdict.baseline`** declares the native engine (`engine` names a host
  toolchain — `python3`, `node`, `go`, `cargo`, or `binary` with an explicit
  `command:` escape hatch), the entry point, and the expected outcome
  (default `not-reproduced`). The engine list is open but known to
  `ass doctor`, which reports each installed engine as a capability; a
  missing engine degrades the scenario ("baseline not runnable here"), it
  does not block the main load.
- A persisted scenario must either declare a baseline or **waive it with a
  reason**: `baseline = { waived = "platform-level bug — no native analogue" }`.
  WAX-600 waives (there is no "native Edge"); WAX-603 declares `python3`.
  `ass promote` refuses a draft with neither, and records baseline evidence
  (or the waiver) in the provenance README.
- The baseline runs by default whenever its engine is present (it is a local
  process — cheap even for remote-target runs); a violated baseline marks
  the run `inconclusive` — the probe is broken or the "bug" also exists
  natively, and either way no fix or reproduction claim stands. A run whose
  baseline could not execute is visibly marked in the report.
- Additional named comparisons stay available under `verdict.controls:` for
  the exotic cases (e.g. comparing two guest engine versions); the baseline
  is simply the distinguished, expected-by-default member.

## 5. Package layout and boundaries

Recommended home: **this repo** (`wasmer-integration-tests`), not
`edge/bgf3k/` as originally sketched in WARP-71. Rationale: every ingredient
already lives here — `TestEnv` ([`src/env.ts`](../src/env.ts)) with its
registry/namespace/token/edge plumbing for all four environments, the
disposable local platform ([`local-platform/`](../local-platform)) with its
component-version resolvers (`BACKEND_VERSION`/`EDGE_VERSION`),
Artillery, the Jest suite that doubles as a workload library, and the
`repros/` convention itself. Rebuilding those in the Edge repo would be pure
duplication. _Accepted 2026-07-30 by the WARP-71 owner; the repo itself may
be renamed in the same move (e.g. `qa-station`) — tracked separately, does
not block._

```text
ass/                      # the harness package (QA-634 "stable boundaries")
  cli.ts                  # ass list | try | run | promote | doctor | audit
  scenario/               # schema (zod) + loader; the model in §4
  fixtures/               # state manager (QA-635); wraps TestEnv + StackMachine SDK
  executors/              # contract (QA-637) + jest | artillery-http | raw-wasmer (QA-638/639/640)
  report/                 # run report writer (QA-641)
  bootstrap/              # `make ass` detector + SETUP.md agent contract (§7)
experiments/
  <slug>/scenario.toml        # Phase 1 drafts; floats allowed, verdict optional,
  <slug>/…                    # never scheduled; ALWAYS committed (see §3)
repros/
  <slug>/scenario.toml        # Phase 2 artifacts, one dir per investigation; pins mandatory
  <slug>/README.md            # provenance, generated by `ass promote`, human-edited
```

Slug resolution: `ass try` searches `experiments/`, `ass run` searches
`repros/`, both case-insensitively; `ass list` shows the union with the
experimental entries marked. A slug never resolves across the boundary —
running a draft under regression semantics requires promoting it first.

The three stable interfaces demanded by QA-634:

1. **Fixture resolution** — `resolve(fixtures, targetEnv) → ResolvedState`
   (URLs, app ids, paths, cleanup handle). Backed by `TestEnv` +
   StackMachine SDK + narrow admin GraphQL, with Doppler-supplied identity
   for remote envs (QA-635).
2. **Executor** — `execute(load, ResolvedState) → RunOutcome` where
   `RunOutcome` is a common shape (timings, per-check counters, raw log
   locations) regardless of executor (QA-637 AC "common outcome shape").
3. **Report** — `report(scenario, ResolvedState, RunOutcome, verdict)` →
   machine-readable JSON + human summary identifying scenario, fixture
   versions, executor, target env, load shape, and failure signature
   (QA-641 AC, verbatim).

## 6. Environments and safety

| Target     | How ASS reaches it                                                                                                                                                                | Guardrails                                                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`    | boots the disposable stack (`make local-platform-up` machinery, [`docs/local-environment-v1.md`](./local-environment-v1.md)); perturbations (`cpus`, cache wipes) apply here only | none needed; hermetic                                                                                                                                                                                     |
| `dev`      | `TestEnv` against `registry.wasmer.wtf`                                                                                                                                           | default remote target                                                                                                                                                                                     |
| `bugtopia` | `TestEnv` against `registry.wasmer.fun`                                                                                                                                           | designated stress env (QA-643); scheduled runs land here                                                                                                                                                  |
| `prod`     | `TestEnv` against `registry.wasmer.io`                                                                                                                                            | **`--i-know-this-is-prod` flag + interactive confirmation + hard arrival-rate/VU caps baked into the executor, non-overridable** (QA-634 AC); stress profiles refuse prod entirely by default (QA-642 AC) |

Environment selection is a CLI/pipeline input (`ass run --env dev …`), never
part of the scenario file — that is what makes the QA-541 flow ("reproduce
locally → fix → confirm on dev → confirm on prod") a re-run rather than a
rewrite. Perturbation sections are ignored with a loud warning on remote
targets (you don't get to CPU-starve prod).

Self-verdicting probes (§4) are the sanctioned shape for prod validation: a
deployed probe answering single GETs sits inside the hard caps by
construction, and because the harness owns probe deployment and teardown,
WAX-603's hand-deployed "temporary — delete when done" apps stop existing as
a category.

## 7. Zero-config bootstrap: `make ass`

Requirement (from the driver of this draft): a fresh checkout on Ubuntu,
NixOS, or macOS reaches a running scenario with no prior setup:

```bash
make ass          # one-time environment setup
ass run wax-600   # just works afterwards
```

The core design decision: **setup is agent-driven, not script-driven.**
Environment heterogeneity (distro package managers, nix vs. FHS, Docker
rootless vs. Desktop, half-installed toolchains, corporate proxies) is
exactly the terrain where imperative bootstrap scripts rot and an agentic
harness excels. `make ass` therefore stays a thin, dependency-free detector
that hands the real work to whatever agent the developer already uses:

1. **Detect the OS/distro** (nix available? apt? brew?) — recorded as hints,
   not acted upon.
2. **Detect the most recently used popular agentic harness** by probing
   well-known state directories (`~/.claude`, `~/.codex`, `~/.cursor`,
   `~/.gemini`, …) and ranking by recent session activity.
3. **Hand off by auto-launch**: spawn the detected harness directly with the
   setup contract loaded — e.g.
   `exec claude "Follow ass/bootstrap/SETUP.md to completion"` — so
   `make ass` drops the user straight into a session that is already doing
   the setup. Interactive mode by default (the user watches and approves);
   the printed command is shown first so the magic is legible and
   re-runnable.
4. **Fallback**: harness found but launch fails → print the launch command
   for manual invocation. No harness found → print `SETUP.md`'s manual
   quick-path (nix users: `nix develop`, via the existing
   [`flake.nix`](../flake.nix); others: the short list of installs) and
   suggest installing a harness.

Two artifacts make this reliable rather than hopeful:

- **[`ass/bootstrap/SETUP.md`]** — the agent-facing setup contract:
  declarative statements of the required end state (Node 22+, `pnpm install`
  done, Docker compose v2 for `local` targets, `gh` auth for pinned release
  assets, `wasmer` for `raw-wasmer` scenarios), OS-specific hints, and known
  failure modes. It instructs the agent, it does not script it.
- **`ass doctor`** — the machine-checkable convergence criterion. It
  enumerates each capability as pass/fail with remediation context, and
  `SETUP.md`'s terminal instruction is "iterate until `ass doctor` exits 0".
  The same command lets CI images and agents self-diagnose later drift.
  Missing optional deps degrade capability (no Docker → remote envs only;
  no `python3`/`node`/`go` → the corresponding native baselines are not
  runnable here), they do not block the tool.

The setup loop is thus: `make ass` → agent runs → agent executes
`ass doctor` → fixes findings → re-runs doctor → done. The script's only
irreplaceable job is knowing which agent to summon and what contract to feed
it.

Secrets never live in scenarios: local needs none, remote identities come
from Doppler (QA-635) or the standard `WASMER_TOKEN` / `~/.wasmer/wasmer.toml`
fallback already honored by `TestEnv`.

## 8. Agentic use (Phase 2 mechanics)

The `repros/` corpus is designed to be operated by agents as much as humans:

- **Self-describing runs.** `ass run <slug>` prints the verdict and the
  report path; an agent needs no repo-specific knowledge beyond "run this,
  read that JSON".
- **`ass promote` closes the loop.** An investigation's draft in
  `experiments/` plus its last successful `try` already contain the working
  combination; promote turns them into the committed, pinned artifact.
- **Regression scheduling.** QA-642's reusable pipeline workflow takes
  `(scenario, env, executor, thresholds)` as inputs, so any committed repro
  is schedulable (nightly on Bugtopia per QA-643) without further glue.
- **Promotion path.** A fixed bug's scenario either stays in `repros/` on a
  schedule (`lifecycle` fixed, watched for regression), or its workload
  graduates into the blocking Jest suite (`lifecycle` retired, pattern:
  [`tests/superpanics/`](../tests/superpanics)) — recorded in the typed
  `meta.lifecycle` field, not free-form notes (§4).
- **`ass audit`.** Because lifecycle is typed, the corpus is a queryable
  register: enumerate `open` scenarios by age, flag `fixed` scenarios whose
  last floating run reproduced (unreported regression), and — as a follow-up
  once CI holds a Linear token — cross-check `lifecycle.state` against the
  linked ticket's status (open scenario, closed ticket ⇒ someone fixed a bug
  without proof, or forgot to flip the state).

## 9. Delivery mapping

| Ticket          | Deliverable in this design                                                                                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QA-634          | `ass/` package skeleton, scenario schema (§4), CLI `list`/`try`/`run`/`promote` on the `local` target with the `jest` executor — enough to replace the WAX-600 shell script with `repros/wax-600/scenario.toml` as the reference scenario |
| QA-635          | `ass/fixtures/` state manager; Doppler identity; template/fixture/package sources                                                                                                                                                         |
| QA-636          | `backup:` fixture source + `ass fixture export`; blocked on BE-666                                                                                                                                                                        |
| QA-637          | `executors/contract.ts` — `ResolvedState`/`RunOutcome` types (§5)                                                                                                                                                                         |
| QA-638          | `artillery-http` executor; generalize the ECO-403 WordPress crawler into a reusable flow generator                                                                                                                                        |
| QA-639          | `raw-wasmer` executor (binary selection, process-level load) + `host-process` control micro-executor; `repros/wax-603/scenario.toml` replaces the WAX-603 script's local/native modes as the reference                                    |
| QA-640          | remote env targeting (dev/Bugtopia/prod-capped) for all executors; harness-owned probe deployment replaces WAX-603's hand-deployed apps; remote log adapters flagged as follow-up                                                         |
| QA-641          | report writer (verdict fact + assessment + lifecycle), both reference scenarios (`wax-600`, `wax-603`), `ass audit` local checks, this document's successor                                                                               |
| QA-642 / QA-643 | pipeline workflow + Bugtopia qualification                                                                                                                                                                                                |

## 10. Open questions for review

1. ~~**Repo placement**~~ — resolved 2026-07-30: the WARP-71 owner accepted
   `wasmer-integration-tests` (§5). A possible repo rename (e.g.
   `qa-station`) rides the same move but is tracked separately.
2. ~~**Scenario format ownership**~~ — resolved 2026-08-04 (D2): the
   ASS-owned file embeds an Artillery block. The `jest` and `raw-wasmer`
   executors are not Artillery, so Artillery-as-envelope inverts the
   dependency.
3. ~~**HAR replay**~~ — resolved 2026-08-04 (D3): explicitly not v1; in
   scope as a later `load` source (`artillery-engine` supports it via
   flows).
4. ~~**`artillery-engine-wasmer`**~~ — resolved 2026-08-04 (D3): v1 keeps
   `raw-wasmer` as a plain executor; a custom Artillery engine is deferred
   until arrival-rate shaping of process spawns is actually needed.
5. ~~**Load profiles**~~ — resolved 2026-08-04 (D8): amendment accepted; the
   load block may declare several executor configurations with exactly one
   _active_ per run, superseding the original "exactly one executor block"
   rule.
6. **`repros/` migration**: the two hand-written script repros keep their
   current layout until each is superseded by its `repros/<slug>/`
   declaration; WAX-603's live probe apps (`wasmer/fh-repro-temp`,
   `lorentz-dev/fh-repro-temp`) are torn down once harness-owned probe
   deployment exists. Confirm nothing schedules against those apps meanwhile.
   _Note (2026-08-04): the WAX-603 script + probe dir live only on the
   unmerged `wax-603-wasix-timed-waits-never-expire` branch; merging it is a
   Phase 4 prerequisite._

## 11. Resolved during review (2026-07-30)

Recorded here so the draft and its review stay one artifact; each lands as a
decision row in the worklog:

- **`meta.lifecycle`** (§4): typed discriminated union `open`/`fixed`/
  `retired`; assessment = lifecycle × pinned/floating mode; exit codes and
  pipeline alerting follow the assessment, never the raw verdict fact.
- **Predicate classes + evaluability** (§4): executor-observable vs.
  environment-observable; engine-owned capability table; an unevaluable
  predicate is a preflight failure before fixtures resolve. No
  degraded-verdict mode in v1 — it only matters for verdicts mixing both
  classes, which no current scenario has.
- **Four-way outcome** (§4, WAX-603-driven): `inconclusive` joins
  `reproduced`/`not-reproduced`/`setup-failed`; optional
  `not_reproduced_when` provides the positive health proof that separates
  the two.
- **Controls** (§4, WAX-603-driven): declared baselines with expected
  outcomes; violations yield `inconclusive`, not `not-reproduced`.
- **Native baseline as default proof shape** (§4, WARP-71 owner,
  2026-07-30): almost every real Wasmer bug is a native-vs-guest engine
  divergence, so `verdict.baseline` (engine + entry + expected outcome) is
  required at promote unless explicitly waived with a reason; `ass doctor`
  reports installed baseline engines (`python3`, `node`, `go`, `cargo`, …)
  as capabilities.
- **Repo placement** (§5): accepted by the WARP-71 owner; rename to
  something like `qa-station` possible in the same move, tracked separately.
- **Probe verdict contract** (§4, WARP-71 owner, 2026-07-30): one
  `ASS-VERDICT:` marker line, exactly-once semantics, listened for on typed
  channel objects (`{type: log}` — process capture locally, Vector→Loki app
  logs when deployed; `{type: http}` — response body; union open for future
  transports). Exit codes are a consistency check, never the verdict. App
  instance streams are readable on all environments via the existing
  Vector→Loki funnel, narrowing "local-only" to platform process streams.

## 12. Resolved during pre-implementation review (2026-08-04)

Driven by a walkthrough of a hypothetical WAX-712 scenario (two concurrent
requests racing a `threading.Lock`-guarded file write under WASIX); each
lands as a decision row in the worklog:

- **Open questions 2–5 accepted as drafted** (D2, D3, D8 above).
- **One override surface** (§3, D12): `try` and `run` share `--env`,
  `--cpus`, `--executor`, and the generic `--component <name>=<selector>`
  (`--edge`/`--backend` are sugar). Any component override on a persisted
  run derives a floating-mode assessment; overrides never rewrite
  declarations. This replaces the earlier drafts-only `--env`/`--edge`/
  `--cpus` enumeration, which contradicted the `path:` fix-verification
  override promised for package components.
- **Fixture `config` affordance** (§4, D13): app/probe fixtures may declare
  `config: { max_instances: … }`; every target honors it or fails preflight.
  Required for cross-request concurrency repros, where multi-instance
  spread yields structural false negatives.
- **Windowed marker scanning** (§4, D14): verdict markers count only between
  workload start and a bounded quiescence timeout, so a reused probe's
  earlier emissions never contaminate exactly-once evaluation.
- **Exit-code enumeration** (§4, D15): `0` expected/informational, `1`
  usage/validation/preflight error, `2` alerting assessment, `3`
  inconclusive, `4` setup-failed — derived from the assessment, never the
  raw verdict.
