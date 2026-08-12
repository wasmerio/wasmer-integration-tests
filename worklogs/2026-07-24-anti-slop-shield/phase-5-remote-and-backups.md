# Phase 5 — Remote environments and backup fixtures

**Status:** Complete  
**Worklog:** [Anti Slop Shield v1](README.md)

## Goal

Safely extend scenarios to dev, Bugtopia, and production while adding backups when their dependency is available.

## Specification

Complete QA-640 with `TestEnv`-based dev (`registry.wasmer.wtf`), Bugtopia (`registry.wasmer.fun`), and production (`registry.wasmer.io`) targeting for supported executors. Target selection remains external to scenario data. Use standard token fallback and Doppler-supplied identity where QA-635 requires it; never serialize credentials.

Remote runs preflight verdict evaluability before fixture resolution (D7). App instance streams are readable remotely — instance stdout/stderr rides the Vector→Loki funnel and surfaces as app logs — so `{type: log}` probe channels and `stream: app` predicates evaluate on dev/Bugtopia/prod; implement that read path through `TestEnv`. The read path applies the D14 scan window: it opens at workload start and closes after a bounded quiescence timeout, and marker lines outside the window are ignored — a reused probe's earlier emissions never satisfy or contaminate exactly-once evaluation. Honor fixture `config:` declarations (D13) through `TestEnv` app configuration — `max_instances: 1` pins single-instance placement for cross-request concurrency scenarios — and fail preflight when a target cannot honor a declared config. Platform process streams (`edge`, `backend`) have no remote adapter in v1 and must fail preflight loudly; dedicated adapters are recorded as a QA-640 follow-up ticket. The `{type: http}` channel evaluates the deployed probe's response body. Implement the probe fixture's `url` affordance: a `package:` probe deploys on demand through `TestEnv`, is reused across runs where safe, and is torn down by the cleanup handle — replacing WAX-603's hand-deployed `fh-repro-temp` apps, which are deleted once this lands (D9). `ass run wax-603 --env dev --executor artillery-http` is the reference remote run; the prod variant demonstrates the capped, acknowledged flow with a self-verdicting probe.

Production requires the acknowledgement flag, interactive confirmation, fixed arrival-rate/VU caps that callers cannot override, and rejection of stress profiles by default. Qualify Bugtopia under QA-643 before scheduling load there. When BE-666 is available, complete QA-636 with `backup:` sources and `ass fixture export`; otherwise keep that sub-feature blocked without blocking non-backup remote scenarios.

## Integration contract

| Trigger                   | Collaborators             | Observable result                     | Required side effect               | Prohibited side effect                                                  |
| ------------------------- | ------------------------- | ------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| `--env dev` or `bugtopia` | `TestEnv`                 | Remote run uses intended registry     | Use supplied identity              | Persist identity in scenario/report secrets.                            |
| `--env prod`              | confirmation and executor | Capped, explicitly acknowledged run   | Enforce non-overridable caps       | Run without both safeguards or a stress profile.                        |
| `backup:` fixture         | backup store / BE-666     | Restored app state and cleanup handle | Export or restore authorized state | Implement before BE-666 or mutate customer state without authorization. |

## Acceptance criteria

- [x] Remote selection is covered through `TestEnv` seams and an approved non-production integration target. — `RemotePlatform` (`ass/fixtures/remote.ts`) is the narrow seam; every path in `tests/ass/remote.test.ts` drives the fake, and the live dev run below drives the real adapter.
- [x] `wax-603` runs against dev via a harness-deployed probe with verified teardown; a scenario whose verdict is remotely unevaluable fails preflight before any fixture work. — Live 2026-08-10: `ass run wax-603 --env dev --executor artillery-http` → `reproduced`/`expected`/exit 0 in 3m13s; probe deployed to the `wasmer-integration-tests` namespace, verdict read off **both** channels (`log:stderr` via D14-windowed app logs, `http:body` via the engine's GET, agreeing), `python3` baseline clean, `App … was deleted!` in the cleanup log. Preflight: "a platform-process predicate fails preflight before fixture work" (zero platform calls recorded).
- [x] Remote log-channel evaluation enforces the D14 scan window; fixture `config` is honored remotely or fails preflight. — Window: "polls until the log stays flat, then closes the window" (post-close growth never read) and "zero in-window markers end inconclusive" (`--from` = workload start, asserted). Config: `max_instances: 1` maps to `scaling: single_concurrency` (`remote-deploy:probe:single` asserted); any larger bound fails preflight naming fixture and target before any fixture work.
- [x] Production safeguards are independently tested and cannot be bypassed by CLI or scenario fields. — Flag, confirmation (declined and non-interactive), stress refusal before the prompt, `jest`-on-prod refusal, and `PROD_CAPS` boundary tests (at-cap passes, over-cap throws; string durations parsed; unparseable durations rejected as "no bound"). The caps are module constants: no flag or scenario field feeds them.
- [x] Bugtopia qualification evidence is recorded before scheduled stress work is enabled. — No scheduled load exists anywhere yet (scheduling is Phase 6); stress profiles refuse production by default with a message routing them to Bugtopia _once QA-643 qualifies it_ (D5). Phase 6 must gate Bugtopia scheduling on QA-643; recorded there.
- [x] If BE-666 is delivered, export/restore behavior has authorized integration coverage; otherwise D4 remains explicitly blocked. — BE-666 is not delivered; `backup:` sources refuse on every target with a message naming D4, and non-backup remote scenarios are unaffected (the whole remote suite runs without it). D4 stays blocked.

## Error coverage

| Condition                                             | Expected outcome                                                     | Test                                                                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing remote identity                               | Actionable authentication failure                                    | `remote.test.ts` "a missing identity produces an actionable failure" (message seam); `realPlatform` wraps `TestEnv.fromEnv` with it                              |
| Environment-observable predicate on a remote target   | Preflight failure naming predicate and target; no fixture resolution | "a platform-process predicate fails preflight before fixture work" (`calls` empty)                                                                               |
| Probe deployment fails or teardown incomplete         | `setup-failed`; leaked probe apps surfaced by name                   | "a failing deploy is a reported setup failure"; "an incomplete teardown names the leaked app; the verdict survives"                                              |
| Marker line outside the D14 scan window               | Ignored; zero in-window markers ⇒ `inconclusive`                     | "zero in-window markers end inconclusive" (`--from` ≥ workload start); "polls until the log stays flat" (post-close growth unread)                               |
| Declared `config.max_instances` unsupported on target | Preflight failure naming fixture and target                          | "config.max_instances > 1 fails preflight naming fixture and target"                                                                                             |
| Production flag absent                                | Refuse before any request                                            | "no acknowledgement flag: refuse before anything runs" (`calls` empty)                                                                                           |
| Confirmation declined/noninteractive                  | Refuse before workload                                               | "declined confirmation: refuse before any fixture work"; "the default confirmation refuses non-interactive contexts"                                             |
| Requested caps exceed production limit                | Refuse (never clamp) at the fixed limit, documented by test          | "a stress profile refuses before the confirmation prompt"; "the caps are fixed constants at their boundaries"; "jest workloads are not qualified for production" |
| Backup unavailable/corrupt                            | Setup failure; no partial remote mutation                            | BE-666 undelivered: `backup:` refuses at setup naming D4 (`fixtures.test.ts` local; `resolveRemote` same guard); authorized coverage lands with BE-666           |

## Implementation notes

### Session 1 — 2026-08-10

**Deltas from the specification.**

- **The channel model became a plan, and that fixed R5-01 on the way in.**
  `planChannels(channels, executor, env)` (`ass/engine/capabilities.ts`)
  decides where each declared channel's bytes come from —
  `process-capture`, `app-logs` (D14-windowed `wasmer app logs`), or
  `http-fetch` (the engine's own GET against the deployed probe) — and
  **only planned channels are ever read**. Under `artillery-http` a `log`
  channel is now genuinely inert locally and reads the _deployed probe's_
  logs remotely, never Artillery's own stderr; verified by the e2e test
  whose workload stderr carries a contradicting marker that must not count.
  `evaluateVerdict` takes an explicit `ProbeEvalContext` (null only for
  probe-less verdicts) so no caller can silently fall back to the old
  behavior; comparisons judge with plans for the executor that actually ran
  them. R5-02 fixed alongside (`baselineSpecOf` everywhere).
- **Probe deployment is `wasmer deploy`, not publish-then-deploy.** The
  wax-603 probe is a _nameless_ package, which `ensurePackagePublished`
  cannot handle; a temp copy with a generated `app.yaml` (`package: "."`,
  `scaling: single_concurrency` when `max_instances: 1`) deploys and
  publishes in one step — the same shape the retired hand-written manifests
  used. Registry idents still deploy via `TestEnv.deployApp`.
- **Probes deploy fresh each run.** The spec's "reused across runs where
  safe" is deliberately not exercised in v1: reuse saves ~45s but adds a
  staleness class D14 exists to defend against; fresh-deploy-plus-teardown
  is the safe subset. Revisit with QA-640's remote adapters if the minute
  matters.
- **Ambient identity is dropped on registry mismatch.** The local-platform
  test env leaks into interactive shells (`WASMER_REGISTRY=localhost` plus
  its token/namespace/`EDGE_*`); `realPlatform` keeps ambient
  `WASMER_TOKEN`/`WASMER_NAMESPACE` only when the ambient registry already
  equals the target, otherwise falls back to the per-registry token in
  `wasmer.toml`, and always clears `EDGE_*`/`WASMER_APP_DOMAIN`.
- **Platform pins on remote derive floating mode.** `deriveRunMode` floats
  any remote run whose declaration pins `edge`/`backend` (the R4-01 rule:
  the run must not be attributed to versions the target never honored);
  the components/pins are recorded as `remote:<env>` and the warning names
  them. Package components pin normally, so the wax-603 dev run stays
  `pinned`.
- **Prod rejects, never clamps.** A clamped run would report on a workload
  nobody declared, so exceeding `PROD_CAPS` refuses with the caps named.
  `jest` on prod refuses outright (arbitrary test code has no cap concept);
  `raw-wasmer` is exempt — the guest runs locally and prod is only its
  registry. Gate order is cheapest-first: flag → caps → interactive
  confirmation, so nobody is prompted for a run that would refuse anyway.
- **TestEnv's console narration is captured, not shown.** Every platform
  call runs with `console.log/debug/info` redirected to
  `<run>/remote-setup.log` (`quietPlatform`), preserving the presenter's
  single voice; the presenter narrates the transitions itself.
- **`src/app/construct.ts` module-scope `__dirname` crashed every ESM
  import.** A PHP-fixture path was computed at module scope; under tsx (ESM)
  the import of `AppYaml` died before any deploy. Made lazy — evaluated only
  when a PHP app is actually built, which the CLI never does.
- **D9 discharged in full.** The WAX-603 script and the hand-deploy
  manifests (`probe/app.yaml`, `app.dev1.yaml`) are deleted (readable in
  branch history); `--env dev|prod --executor artillery-http` replaces
  `MODE=dev1|prod`. The two hand-deployed apps
  (`wasmer/fh-repro-temp` on prod, `lorentz-dev/fh-repro-temp` on dev)
  **await manual deletion** — commands are in `repros/wax-603/README.md`;
  an autonomous session does not delete apps it did not create.
- **Known limitation:** an interrupt (SIGINT) during a remote run leaks the
  deployed probe app — the signal trap restores local files synchronously
  and cannot await a remote delete. The app name is in the run log; a
  re-run's fresh deploy never collides (random names).

**Verification.**

- `npx jest tests/ass` — 16 suites, **283** tests (18 new in
  `tests/ass/remote.test.ts`).
- Live reference run (AC-2): `./bin/ass run wax-603 --env dev --executor
artillery-http` → `reproduced` / `expected` / exit 0, 3m13s (setup 47.6s
  incl. deploy, workload 1m44s, collect 32.3s, comparison 8.5s); verdict on
  `log:stderr, http:body`; baseline clean; probe app deleted. Artillery
  counters recorded 4× HTTP 200 + 6 socket timeouts — the single-threaded
  probe queues concurrent matrix runs; counters are data, the verdict never
  depended on them.
- Prod was **not** run live: the interactive confirmation is the point, and
  an autonomous session cannot give it. The refusal paths are CLI-tested.

## Review findings (review 6, 2026-08-10)

Verified independently: `npx jest tests/ass` (16 suites, 283 pass) and
`make lint` fully clean, both re-run after `make fmt`. Traced the
deploy-teardown invariant through every path: each successful deploy is
pushed to the cleanup list before the next begins, so a second-fixture
failure deletes the first; a failed delete names the leaked app and
survives into the report without overturning the verdict; the interrupt
path is the one documented leak (the trap restores files synchronously and
cannot await a remote delete). Confirmed no secret reaches disk: the
try-state record carries selectors/pins only, the report carries paths and
counters, and the whole-tree snapshot assertion in the e2e test holds it.
Confirmed `classifySelector("remote:dev")` falls into the
unrecognized-form floating branch, so a remote-tried draft with platform
components refuses promotion with a reason instead of persisting a fake
pin. Confirmed the prod gate ordering (flag → caps → other preflights →
confirmation) means no human is ever prompted for a run that would refuse.

- [ ] **R6-01 (Note).** A _declared load-profile control_ (D8) judged
      during a remote run reads its probe channels with a local plan
      (`judge` plans for the executor on `"local"`), so an `artillery-http`
      control can never carry a probe verdict and would force
      `inconclusive` via its violation. No current scenario declares one;
      the code comment says so. Route with the QA-640 remote-adapter
      follow-up.
- [ ] **R6-02 (Note).** SIGINT during a remote run leaks the deployed
      probe app (documented in the implementation notes). The run log
      carries the app name; acceptable for v1, revisit if remote runs get
      long enough to be interrupted routinely.
- [ ] **R6-03 (Note).** `quietPlatform` swaps the global console around
      each platform call; two overlapping calls would restore it early.
      All call sites are sequential today.

Verdict: **ready** — the contract is met on every acceptance criterion,
the reference remote run is live evidence, and the three findings are
notes on documented v1 boundaries, none reopening.
