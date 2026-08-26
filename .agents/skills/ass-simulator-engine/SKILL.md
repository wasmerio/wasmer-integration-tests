---
name: ass-simulator-engine
description: Extend or debug the business-simulator engine in ass/simulator/ — the reconciler (resource model, adapters, observe/diff/apply, ledger), the two-layer local-only guard, and how to add a new state axis with tests. Use when changing simulator engine code, adding an adapter, or investigating diff/teardown behavior.
---

# ASS simulator engine

## One engine

`ass/simulator/` is the **reconciler** behind `ass up`, `ass diff`,
`ass verify`, `ass down` and `ass status`. (A rebuild-shaped v1 seeder
engine existed until 2026-08; it was deleted and the reconciler flattened
into `ass/simulator/` — `tests/ass/simulator-pin.test.ts` is the behavior
contract that proved the cut safe, and it remains the law.) Design:
`docs/business-simulator-v2-reconciler.md` in the stackmachine.com repo;
implementation notes and measurements:
`worklogs/2026-08-19-business-simulator-v2/`.

## Architecture (the part to read first)

The design's one rule is a hard split, and the code keeps it:

- **`expand/` names no store.** Declaration + seed + anchor -> a lazy,
  ordered stream of `Resource { id, kind, spec, fingerprint, deps, policy }`.
  Pure, unit-testable with no platform (`tests/ass/simulator-engine.test.ts`).
- **`adapters/` names no scenario.** One adapter per kind:
  `observe(scope)` (marker-scoped, predicate *inside* the statement),
  `diff(desired, observed)`, `apply(ops)`. `engine/registry.ts` is the one
  place the surface is enumerated. `adapters/inserts.ts` holds the shared
  server-side ClickHouse insert generators.
- **`plan.ts` is a pure merge-join** between the two sorted streams. It
  asserts ordering: an expander that yields out of order is a bug, not a
  plan full of creates and deletes.
- **`engine/scheduler.ts`** stages kinds by the dependency graph derived
  from the operations, runs a stage concurrently under three lane
  semaphores (sdk / clickhouse / postgres), reverses the order for
  delete-only kinds, and skips a kind whose dependency failed.
- **`ledger.ts`** owns `.ass/state/<slug>.held.json` (`stateVersion: 2`,
  an on-disk discriminator, not a code version): an inspection surface, a
  fast path, and the record of the last declared intent — never a record
  of state. Atomic tmp+rename writes; corrupt files are loud errors, never
  treated as absent. No secrets.
- **`verbs.ts`** is the CLI surface (`runUp`/`runDiff`/`runDown`); all four
  verbs are the same loop with a different desired set and exactness.
  `deps.ts` (`SimulatorDeps`) is the test seam: a fake platform driver,
  liveness probe, and — the store seam — injected fake adapters, so a full
  non-plan `up`/`down` reconcile is unit-drivable with no live stores
  (see the harnesses in `tests/ass/simulator.test.ts` and the pin suite).

**Adding a state axis** = one schema block in `scenario.ts`, one expander
in `expand/`, one adapter in `adapters/`, one line in
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

## Declarations

Scenario files live in the stackmachine.com repo (`simulator/scenarios/`);
the schema is `ass/simulator/scenario.ts` (`assSchema = 2`, zod strict —
`verdict` structurally impossible). `assSchema = 1` files load unchanged:
`upgradeV1` maps the old `telemetry.rawWindow` onto `precision.raw` and
everything else is a superset. `--set path=value` tweaks a declaration
without editing the file; overrides are canonicalized and recorded in the
ledger.

## Guard (D-K)

Two independent layers, no override: `assertLocalOnly` at verb entry, and
`guardedUrl` inside every client factory (`clients/graphql.ts`,
`clients/postgres.ts`, `clients/clickhouse.ts`) immediately before
connecting. A trip is a hard refusal. Both layers are test-covered; keep
them that way. All randomness flows through `random.ts` (seeded mulberry32,
forkable streams); `Math.random` is banned under `ass/simulator/`
(grep-tested in `tests/ass/simulator.test.ts`).

## Adding an app fixture

`ass/simulator/fixtures.ts` is the anchor-app registry: add the name to
`FIXTURE_NAMES`, a `FixtureSpec` (wasmer.toml + files; keep it
self-contained — no `src/` imports) and its `fixturePackage()` entry. The
schema enum picks it up automatically; make the page identify
`{ app, fixture }` so mixes stay probeable, and check the dependency
package is mirrored by the local platform (auto-discovered from
`src/app` constructors, else add to `local-platform/package-seed.txt`).
Weighted-mix assignment lives in `expand/world.ts` (`fixtureAssignments` —
exact largest-remainder counts, seeded shuffle).

## Adding a state axis

1. Add the block to `scenario.ts` (strict object, optional).
2. Write the expander in `expand/`: pure, yields `Resource`s in id order
   (the merge-join depends on it), fingerprints over diff-relevant spec
   only.
3. Write the adapter in `adapters/`: `observe` marker-scoped, `diff`
   (default or bucket semantics), `apply` idempotent per operation.
4. Register the adapter in `engine/registry.ts` and, if it is a new kind,
   add it to `KIND_ORDER` in `model.ts` at the right dependency position.
5. Datastore access only through the guarded client factories / the
   engine context.
6. Tests in `tests/ass/simulator*.test.ts`: schema, expansion determinism
   and order, diff table, guard refusal for any new endpoint. Run
   `npx jest tests/ass/simulator` + `make lint`. Do not weaken the pin
   suite (`simulator-pin.test.ts`) — it is the refactor-proof contract.

## Debugging

- `ass up --verbose` streams platform/deploy output; `ass status --json`
  is the machine surface.
- The ledger is the record of declared intent, never of state: losing it
  degrades the engine to additive-only plus one full OBSERVE, never to a
  wrong write. `down` failures keep the ledger for a re-run to converge.
- Empirical read-path notes (which tables feed which GraphQL fields, MV
  cascade shapes, the subscription-ledger model) live in the
  stackmachine.com worklogs `worklogs/2026-08-14-business-simulator-v1/`
  and `worklogs/2026-08-19-business-simulator-v2/` — read those before
  changing a writer.
