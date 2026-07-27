# WAX-603: timed waits on threading primitives never expire under WASIX Python

Linear: [WAX-603](https://linear.app/wasmer/issue/WAX-603)

On WASIX Python 3.13 (`python/python@3.13.5`, reports `3.13.0rc2-wasix`),
every *timed* wait on a threading primitive blocks forever instead of
timing out:

| Primitive | Expected | Observed |
|---|---|---|
| `Lock.acquire(blocking=False)` on held lock | `False` instantly | ✅ ok |
| Blocking `Lock.acquire()` + cross-thread release | wakes promptly | ✅ ok |
| `time.sleep(0.5)` | ~0.5s | ✅ ok |
| `Event.wait(timeout=1)` | `False` at ~1s | ❌ hangs forever |
| `Lock.acquire(timeout=1)` on held lock | `False` at ~1s | ❌ hangs forever |
| `Condition.wait(timeout=1)` | `False` at ~1s | ❌ hangs forever |
| `Queue.get(timeout=1)` | `Empty` at ~1s | ❌ hangs forever |
| `faulthandler.dump_traceback_later(1)` | dump within 1s | ❌ never fires |

Wakeups work; timeout *expiry* never fires. This spans CPython 3.13's
parking-lot waits and the legacy `PyThread_acquire_lock_timed` path
(faulthandler's C watchdog), pointing at the WASIX timed-park/futex
primitive underneath. Consequence: any timeout-based recovery path
(DB/HTTP pool waits, consumer loops, watchdogs, `future.result(timeout)`)
silently degrades to an infinite wait. Under load the bug hides — stray
notifies wake waiters and libraries' wall-clock rechecks fire — but on a
quiet instance threads park forever.

Reproduced identically (2026-07-27) on local `wasmer run` (CLI 7.2.0),
prod Edge, and dev1 Edge.

## One-click repro

From the `wasmer-integration-tests` repo root:

```bash
./repros/WAX-603-wasix-timed-waits-never-expire.sh
```

Exit 0 = reproduced, exit 2 = fixed. `MODE=native` runs the same matrix
on host python3 as the passing control (all ok, exit 2); `MODE=prod` /
`MODE=dev1` curl the live deployments. To verify a candidate fix, point
it at your build:

```bash
PYTHON_PKG=path/to/fixed-python ./repros/WAX-603-wasix-timed-waits-never-expire.sh
```

## Files

- `repro.py` — the matrix. Hang-safe by construction: each check runs in
  a daemon thread watched by a wall-clock guard built only from
  primitives verified to work (sleep + flag polling), so the report
  always completes (~25s worst case). `--once` prints to stdout; default
  mode serves the matrix over HTTP on `:8080` for Edge deploys.
- `wasmer.toml` — packages `repro.py` with `python/python@3.13.5`.
- `app.yaml` — prod deploy manifest (`wasmer/fh-repro-temp`).
- `app.dev1.yaml` — dev1 deploy manifest (`lorentz-dev/fh-repro-temp`).

## Live deployments (temporary — delete when done)

- prod: https://fh-repro-temp.wasmer.app/ (`GET /` runs the matrix)
- dev1: https://fh-repro-temp.wasmer.dev/

Redeploy: `wasmer deploy` from this directory with prod credentials, or
swap `app.yaml` for `app.dev1.yaml` with dev1 credentials.
