# WAX-600 — Edge wasix 759ca9d cross-Store panic under CPU starvation

Declarative reproduction of the cross-Store WASIX panic
([WAX-600](https://linear.app/wasmer/issue/WAX-600)): under CPU starvation,
Edge running the wasix `759ca9d` bump panics with `object used with the wrong
context` while serving the remote-built `next-react-server-components`
template app. Investigation notes: hivemind
`knowledge/04-codebases/edge/2026-07-16-wasix-759ca9d-cross-store-panic.md`.

## Run it

```bash
pnpm ass run wax-600
```

Boots the disposable local platform on the pinned failing Edge and backend
releases with the Edge container capped at 1 CPU and its compiler/webc caches
wiped, runs the existing Jest template workload, and greps the Edge process
stream for the panic signature. Retained evidence (`edge_panic_context`) and
the machine-readable report land in `.local-platform/current/ass/report.json`.

Fix verification is a run-time override, never an edit to this declaration:

```bash
pnpm ass run wax-600 --edge path:$HOME/Projects/wasmer/edge/target/release/edge
```

(The container runtime is `debian:bookworm-slim` — build against glibc ≤ 2.36
or bump `local-platform/edge-runtime/Dockerfile`.)

## Provenance

Hand-converted in Phase 2 of the Anti Slop Shield worklog
(`worklogs/2026-07-24-anti-slop-shield/phase-2-local-reference-repro.md`)
from `repros/WAX-600-edge-wasix-cross-store-panic.sh`, preserving its exact
pins, CPU-cap trigger, cache wipes, workload, panic grep, and panic-context
evidence. The scenario declares `cpus: 1` (the script's documented retry
value and the design-doc reference declaration); the script's default was
`cpus: 2` with a retry hint.

The script was **retired on 2026-08-07** under worklog decision D9, having
been proven equivalent by the pinned run of 2026-08-06 (run dir
`20260806T061207Z-a9c5cb0`): `reproduced` / `expected` / exit 0, retaining
the `759ca9d/store.rs:202:9` cross-Store assertion as evidence. Read the
script at commit `a1e41c1` if the pre-harness shape is ever needed.

## Reproduction evidence

| Run                       | Selectors                                         | Outcome            | Assessment    |
| ------------------------- | ------------------------------------------------- | ------------------ | ------------- |
| `20260806T061207Z-a9c5cb0` | declared pins                                     | `reproduced`       | `expected`    |
| `20260806T064245Z-a9c5cb0` | `--edge resolve_prod --backend resolve_prod`      | `not-reproduced`   | candidate-fix |

The floating run is the first signal the bug is fixed upstream, but the
scenario stays `lifecycle: open`: the failure is a starvation race, so one
quiet floating run is weaker evidence than a positive one, the declaration
still lacks a `not_reproduced_when` health proof, and `fixed_in` would need a
bisect between the reproducing `v2026-07-16_1_fcdd9c4_dev1` edge and the
quiet `v2026-08-05_1_419b336_dev1`.
