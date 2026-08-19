---
name: ass-simulator-engine
description: Extend or debug the business-simulator engine in ass/simulator/ — the v2 reconciler (resource model, adapters, observe/diff/apply, ledger), the v1 seeder behind --engine v1, the two-layer local-only guard, and how to add a new state axis with tests. Use when changing simulator engine code, adding an adapter or seeder, or investigating diff/teardown behavior.
---

# ASS simulator engine

## Two engines

`ass/simulator/v2/` is the **reconciler** and the default for `ass up`,
`ass diff`, `ass verify` and `ass down`. `ass/simulator/` (v1) is the
rebuild-shaped seeder, reachable with `--engine v1` or `SIM_ENGINE=v1`, and
still owns its held-descriptor contract and its tests. Design:
`docs/business-simulator-v2-reconciler.md` in the stackmachine.com repo;
implementation notes and measurements:
`worklogs/2026-08-19-business-simulator-v2/`.

## v2 architecture (the part to read first)

The design's one rule is a hard split, and the code keeps it:

- **`expand/` names no store.** Declaration + seed + anchor -> a lazy,
  ordered stream of `Resource { id, kind, spec, fingerprint, deps, policy }`.
  Pure, unit-testable with no platform (`tests/ass/simulator-v2.test.ts`).
- **`adapters/` names no scenario.** One adapter per kind:
  `observe(scope)` (marker-scoped, predicate *inside* the statement),
  `diff(desired, observed)`, `apply(ops)`. `engine/registry.ts` is the one
  place the surface is enumerated.
- **`plan.ts` is a pure merge-join** between the two sorted streams. It
  asserts ordering: an expander that yields out of order is a bug, not a
  plan full of creates and deletes.
- **`engine/scheduler.ts`** stages kinds by the dependency graph derived
  from the operations, runs a stage concurrently under three lane
  semaphores (sdk / clickhouse / postgres), reverses the order for
  delete-only kinds, and skips a kind whose dependency failed.

**Adding a state axis** = one schema block in `v2/scenario.ts`, one
expander in `v2/expand/`, one adapter in `v2/adapters/`, one line in
`engine/registry.ts`. Nothing else changes — that is invariant I8 and it is
the design's own success criterion.

**Three things that will bite you** (each cost a live debugging round):

1. **OBSERVE order.** Binding kinds (`user`, `namespace`, `app`,
   `app-version`, `volume`, `database`) are observed first and
   sequentially; everything else translates store ids through the identity
   map and will re-create existing rows if it runs before them.
2. **The rollup cascade.** Never delete-and-reinsert a `*_by_owner` or
   `*_daily*` row: they merge several apps and 24 hours, and a materialized
   view re-adds to them on every insert. `adapters/rollups.ts` is the only
   correct sequence (clear the app level, let the cascade run, rebuild the
   coarser levels from it).
3. **Bucket diffing is one-sided.** `observed >= desired` is `keep` plus a
   reported surplus. Only `--exact`, a teardown, or a *declared change*
   (this day's desired digest differs from the ledger's last one) writes
   downward.

## v1 (behind `--engine v1`)

`ass/simulator/` implements `ass up` (seed and hold product state on the
local platform), `ass down` (replay the held teardown descriptor), and
`ass status` (inspection). Scenario files live in the stackmachine.com
repo (`simulator/scenarios/`); the schema is `ass/simulator/schema.ts`
(`assSchema: 1`, zod strict — `verdict` structurally impossible).

## Architecture

- **Descriptor** (`descriptor.ts`) — `.ass/state/<slug>.held.json`, the
  serialized replacement for `ResolvedState.cleanup`'s in-process closure.
  Entries are appended and flushed as resources are created (`emit`), so a
  crash leaves a descriptor covering everything that exists. `down`
  replays entries in reverse creation order, checkpointing `done` per
  entry; a partial teardown resumes, never restarts. Atomic tmp+rename
  writes; corrupt files are loud errors, never treated as absent. No
  secrets — teardown re-reads `test-env.sh`.
- **Registries** (`registry.ts`) — the maintainability seam. A `Seeder`
  is `{ block, plan(decl, ctx) → lines, apply(decl, ctx, emit) }` in spec
  §3.1 order (account → apps → telemetry → billing); a `TeardownKind` is
  `{ kind, down(entry, ctx) → Promise<string[]> }` — idempotent, never
  throws, error strings accumulate. Correlation IDs flow through
  `ctx.ids` (account fills PKs; apps fills the app map; telemetry fills
  totals billing consumes).
- **Guard** (`guard.ts`, D-K) — two independent layers, no override:
  `assertLocalOnly` at verb entry, and `guardedUrl` inside every client
  factory (`clients/graphql.ts`, `clients/postgres.ts`,
  `clients/clickhouse.ts`) immediately before connecting. A trip is a hard
  refusal. Both layers are test-covered; keep them that way.
- **D-B drift assertions** — every writer compares its expected columns to
  the live table before the first insert (`assertColumns` /
  `assertTableColumns`) and fails naming the delta and the generating
  source. Update the expected-column maps when the backend/Edge schema
  moves; never skip the check.
- **Determinism** — all randomness flows through `random.ts` (seeded
  mulberry32, forkable streams). `Math.random` is banned under
  `ass/simulator/` (grep-tested). Telemetry counts are decided client-side
  by `traffic.ts` and recorded as `projectedDaily` in the descriptor —
  the seeded e2e asserts the dashboard shows exactly those numbers, so
  generator changes that alter counts are breaking changes to held
  expectations (reseed required, tests updated deliberately).

## Adding an app fixture

`ass/simulator/fixtures.ts` is the anchor-app registry: add the name to
`FIXTURE_NAMES`, a `FixtureSpec` (wasmer.toml + files; keep it
self-contained — no `src/` imports) and its `fixturePackage()` entry. The
schema enum picks it up automatically; make the page identify
`{ app, fixture }` so mixes stay probeable, and check the dependency
package is mirrored by the local platform (auto-discovered from
`src/app` constructors, else add to `local-platform/package-seed.txt`).
Weighted-mix assignment lives in `seeders/apps.ts`
(`normalizeFixtureMix`/`assignFixtures` — exact largest-remainder counts,
seeded shuffle).

## Adding a state axis

1. Add the block to `schema.ts` (strict object, optional).
2. Write a `Seeder` in `seeders/<axis>.ts`: `plan()` pure (feeds
   `--plan`), `apply()` creating resources and `emit()`ing entries keyed
   by concrete created IDs *before* moving on.
3. Write a `TeardownKind` in `kinds.ts`: zod-parse your entry, delete by
   the recorded IDs, treat absent rows as success, return error strings.
4. Register both in `registry.ts` (`builtinSeeders` order matters).
5. Datastore access only through the guarded client factories.
6. Tests in `tests/ass/simulator*.test.ts`: schema, plan determinism,
   guard refusal for any new endpoint, teardown idempotency. Run
   `npx jest tests/ass/simulator` + `make lint`.

## Debugging

- `ass up --verbose` streams platform/deploy output; `ass status --json`
  is the machine surface.
- The descriptor is the ground truth for what exists; `down` failures
  print accumulated per-entry errors and keep the descriptor for resume.
- Empirical read-path notes (which tables feed which GraphQL fields, MV
  cascade shapes, the subscription-ledger model) live in the
  stackmachine.com worklog `worklogs/2026-08-14-business-simulator-v1/`
  phase files — read those before changing a writer.
