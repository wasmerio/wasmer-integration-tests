# WAX-609 — Repeated database connect/close never plateaus in the guest

Promoted from `experiments/wax-609-wasix-node-leaks-memory-on-every-outbound-connection/` by `ass promote wax-609-wasix-node-leaks-memory-on-every-outbound-connection`.

## Run it

```bash
pnpm ass run wax-609-wasix-node-leaks-memory-on-every-outbound-connection
```

Nothing to set up: the TLS database peer runs in-process (`peer.mjs`). It needs
`openssl` on PATH to mint a throwaway certificate, and `wasmer` to run the guest.

Fix verification is a run-time override, never an edit to this declaration:

```bash
PROBE_JS_PACKAGE=/path/to/your/build \
  pnpm ass run wax-609-wasix-node-leaks-memory-on-every-outbound-connection
```

The runtime is named by an environment variable rather than
`fixtures.components`, which is why the pinned-components table below is empty:
a `jest` workload is the only executor that can measure the guest from outside,
and `load.jest` has no `env:` for `{{ component.* }}` to flow through. The run
this was promoted from used `wasmer/edgejs-quickjs@0.2.0` (Node 24.13.2 for
wasix) on `wasmer 7.3.0`.

## What a run tells you

Three arms run every time, and the verdict is the difference between them:

| arm | runtime | peer | expected |
| --- | ------- | ---- | -------- |
| workload | wasix Node | TLS | `reproduced` — climbs ~85 KB/cycle, never plateaus |
| baseline | host Node | TLS | `not-reproduced` — rules out the fixture's JavaScript |
| control `plaintext` | wasix Node | plaintext | `not-reproduced` — rules out sockets, isolating TLS |

A reproduction prints the memory curve, what it rules out, the cycle under test,
and a path to the full sample series as CSV. If the workload ever comes back
`not-reproduced` while both controls hold, the leak is fixed; if a *control*
flips, distrust the run before the runtime — measurement without a forced
collection on both sides reads a healthy host as a leak.

## Pinned components

| Component | Selector | Origin |
| --------- | -------- | ------ |


## Provenance

| Field | Value |
| ----- | ----- |
| Source draft | `experiments/wax-609-wasix-node-leaks-memory-on-every-outbound-connection/scenario.toml` |
| Recorded run | 2026-08-31T12:15:26.640Z (`.local-platform/ass/runs/2026-08-31T12-09-17-150Z/report.json`) |
| Target | `local`, mode `pinned` |
| Workload | `jest`: `{"spec":"wax-609-leak.test.ts","timeoutSeconds":1200}` |
| Outcome | `reproduced` (assessment `informational`) |
| Baseline (D10) | node `measure.mjs --target host` (expects not-reproduced); exercised on the recorded run (ok) |

The reproduction above is what the recorded run observed on the pinned
selectors. Edit this file freely — only `scenario.toml` is machine-owned.
