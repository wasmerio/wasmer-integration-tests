#!/usr/bin/env bash
# Reproduce: timed waits on Python threading primitives never expire on WASIX.
# Event.wait(timeout) / Lock.acquire(timeout) / Condition.wait(timeout) /
# Queue.get(timeout) hang forever; faulthandler.dump_traceback_later never
# fires. Untimed wakeups, nonblocking acquire and sleep all work.
# Linear: WAX-603 — https://linear.app/wasmer/issue/WAX-603
# Run from the wasmer-integration-tests repo root. Needs only the wasmer CLI.
# Knobs:
#   PYTHON_PKG=python/python@3.13.5  interpreter package under test
#                                    (point at a local build to verify a fix)
#   MODE=local|prod|dev1|native      where to run the matrix (default: local)
#                                    prod/dev1 curl the live repro apps
#                                    (wasmer/fh-repro-temp, lorentz-dev/
#                                    fh-repro-temp) if still deployed;
#                                    native runs host python3 as the
#                                    passing control (exits 2)
set -euo pipefail

DIR=repros/WAX-603-wasix-timed-waits-never-expire
PYTHON_PKG="${PYTHON_PKG:-python/python@3.13.5}"
MODE="${MODE:-local}"

[[ -d "$DIR" ]] ||
  { echo "error: run from the wasmer-integration-tests repo root" >&2; exit 1; }

case "$MODE" in
  local)
    echo "=== running matrix locally: wasmer run $PYTHON_PKG ==="
    # timeout(1) is a backstop only: the matrix guards its own hangs
    # (wall-clock watchdogs built from primitives that DO work) and
    # completes in ~25s even when everything is broken.
    out=$(timeout 180 wasmer run "$PYTHON_PKG" \
      --volume "$DIR:/work" -- /work/repro.py --once 2>&1 | grep -v "^warning:")
    ;;
  prod)
    echo "=== fetching matrix from prod Edge ==="
    out=$(curl -sf -m 90 https://fh-repro-temp.wasmer.app/)
    ;;
  dev1)
    echo "=== fetching matrix from dev1 Edge ==="
    out=$(curl -sf -m 90 https://fh-repro-temp.wasmer.dev/)
    ;;
  native)
    echo "=== control: running matrix on host python3 ==="
    out=$(python3 "$DIR/repro.py" --once)
    ;;
  *)
    echo "error: MODE must be local, prod, dev1 or native" >&2; exit 1
    ;;
esac

echo "$out"
echo
echo "=== verdict ==="
if grep -q "^verdict: REPRODUCED" <<<"$out"; then
  echo "REPRODUCED: timed waits never expire (FAIL lines above)."
  echo "A fixed runtime/interpreter must turn every FAIL into ok."
  exit 0
elif grep -q "^verdict: all primitives OK" <<<"$out"; then
  echo "NOT reproduced: all primitives behaved — bug appears fixed here."
  exit 2
else
  echo "inconclusive: matrix output not recognized." >&2
  exit 3
fi
