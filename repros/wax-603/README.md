# WAX-603 — WASIX timed waits on threading primitives never expire

Linear: [WAX-603](https://linear.app/wasmer/issue/WAX-603)

## Run it

```bash
pnpm ass run wax-603
```

Verify a candidate interpreter fix without editing this declaration:

```bash
pnpm ass run wax-603 --component python=path:/path/to/your/build
```

Run it against a remote Edge (the harness deploys the probe as an app,
reads its verdict off the app logs and the HTTP body, and tears it down):

```bash
pnpm ass run wax-603 --env dev --executor artillery-http
```

The prod variant additionally requires `--i-know-this-is-prod`, an
interactive confirmation, and runs under fixed non-overridable caps.

## The bug

On WASIX Python 3.13 (`python/python@3.13.5`, which reports `3.13.0rc2-wasix`),
every _timed_ wait on a threading primitive blocks forever instead of timing
out:

| Primitive                                   | Expected           | Observed         |
| ------------------------------------------- | ------------------ | ---------------- |
| `Lock.acquire(blocking=False)` on held lock | `False` instantly  | ok               |
| Blocking `Lock.acquire()` + cross-thread release | wakes promptly | ok               |
| `time.sleep(0.5)`                           | ~0.5s              | ok               |
| `Event.wait(timeout=1)`                     | `False` at ~1s     | hangs forever    |
| `Lock.acquire(timeout=1)` on held lock      | `False` at ~1s     | hangs forever    |
| `Condition.wait(timeout=1)`                 | `False` at ~1s     | hangs forever    |
| `Queue.get(timeout=1)`                      | `Empty` at ~1s     | hangs forever    |
| `faulthandler.dump_traceback_later(1)`      | dump within 1s     | never fires      |

Wakeups work; timeout _expiry_ never fires. This spans CPython 3.13's
parking-lot waits and the legacy `PyThread_acquire_lock_timed` path
(faulthandler's C watchdog), pointing at the WASIX timed-park/futex primitive
underneath. Consequence: any timeout-based recovery path (DB/HTTP pool waits,
consumer loops, watchdogs, `future.result(timeout)`) silently degrades to an
infinite wait. Under load the bug hides — stray notifies wake waiters and
libraries' wall-clock rechecks fire — but on a quiet instance threads park
forever.

## Why this is a Wasmer bug and not a Python one

The scenario declares a `python3` native baseline (D10): the same `repro.py`
runs on the host interpreter and must report `not-reproduced`. The claim is
the _divergence_, so a run whose baseline disagrees ends `inconclusive`
instead of asserting a reproduction. A host without `python3` cannot make the
claim at all, so the run is marked degraded and `ass promote` refuses it.

## Files

- `scenario.toml` — the declaration. Both the workload and the baseline run
  the same probe; only the engine underneath differs.
- `probe/repro.py` — the matrix. Hang-safe by construction: each check runs
  in a daemon thread watched by a wall-clock guard built only from primitives
  verified to work (sleep + flag polling), so the report always completes
  (~25s worst case). It states its own result in one `ASS-VERDICT:` line
  (D11) on stderr and in the served body. `--once` prints the matrix; the
  default mode serves it over HTTP on `:8080` for Edge deploys.
- `probe/wasmer.toml` — packages `repro.py` with `python/python@3.13.5`.
  The package is nameless on purpose: the harness deploys the directory
  with `wasmer deploy` (`package: .`), so nothing is published standalone.

## What this replaces

`repros/WAX-603-wasix-timed-waits-never-expire.sh` predated the harness and
is retired (D9; readable in this branch's history). `pnpm ass run wax-603`
replaces its `local` mode, the `python3` baseline replaces `MODE=native`,
`--component python=…` replaces `PYTHON_PKG=…`, and
`--env dev|prod --executor artillery-http` replaces `MODE=dev1|prod` — with
harness-owned probe deployment and teardown instead of the script's
hand-deployed `fh-repro-temp` apps.

Provenance: reproduced identically (2026-07-27) on local `wasmer run` (CLI
7.2.0), prod Edge, and dev1 Edge. Re-confirmed through the harness on
2026-08-07 (local `wasmer run`, 5 primitives broken, `python3` baseline
clean) and on 2026-08-10 against dev Edge (harness-deployed probe,
`reproduced` on both the app-log and HTTP channels, baseline clean, probe
app deleted afterwards).

## Hand-deployed apps (pending manual teardown, D9)

The script's era left two hand-deployed probe apps that the harness has now
replaced. They should be deleted by a human with the matching credentials:

```bash
WASMER_REGISTRY=https://registry.wasmer.io/graphql wasmer app delete wasmer/fh-repro-temp
WASMER_REGISTRY=https://registry.wasmer.wtf/graphql wasmer app delete lorentz-dev/fh-repro-temp
```
