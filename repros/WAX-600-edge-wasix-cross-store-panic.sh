#!/usr/bin/env bash
# Reproduce the Edge wasix 759ca9d cross-Store panic locally.
# Linear: WAX-600 — https://linear.app/wasmer/issue/WAX-600
# Run from the wasmer-integration-tests repo root.
# Knobs:
#   CPUS=1        edge container CPU cap (lower = more likely to panic)
#   JEST_CMD=...  test command to run
#   EDGE_PIN=...  any resolver selector, e.g. a local build to verify a fix:
#                 EDGE_PIN=path:$HOME/Projects/wasmer/edge/target/release/edge
#                 (runtime container is debian:bookworm-slim — build against
#                 glibc <= 2.36 or bump local-platform/edge-runtime/Dockerfile)
#   BACKEND_PIN=... same, for the backend image archive
# Details: hivemind knowledge/04-codebases/edge/2026-07-16-wasix-759ca9d-cross-store-panic.md
set -euo pipefail

CPUS="${CPUS:-2}"
JEST_CMD="${JEST_CMD:-npx jest ./tests/app/templates.test.ts -t next-react-server-components}"
BACKEND_PIN="${BACKEND_PIN:-github-release:wasmerio/backend:v2026-07-15_2_9a6c3d4:*image*.tar*}"
EDGE_PIN="${EDGE_PIN:-github-release:wasmerio/edge:v2026-07-16_1_fcdd9c4_dev1:edge}"

[[ -f docker-compose.local-platform.yaml && -f Makefile ]] ||
  { echo "error: run from the wasmer-integration-tests repo root" >&2; exit 1; }
GH_TOKEN="${GH_TOKEN:-$(gh auth token)}" # needs release read on wasmerio/{backend,edge}

# Backups; everything is restored on exit.
[[ -f local.env ]] && cp local.env local.env.repro-bak
cp docker-compose.local-platform.yaml docker-compose.local-platform.yaml.repro-bak
cleanup() {
  mv -f docker-compose.local-platform.yaml.repro-bak docker-compose.local-platform.yaml
  if [[ -f local.env.repro-bak ]]; then mv -f local.env.repro-bak local.env; else rm -f local.env; fi
}
trap cleanup EXIT

# Pin the versions (local.env overrides ambient env; defaults = failing CI run).
cat > local.env <<EOF
export BACKEND_VERSION=$BACKEND_PIN
export EDGE_VERSION=$EDGE_PIN
EOF

# Starve the edge container of CPU (the trigger; GH runners have 4 vCPU total)
# and wipe its caches so instances cold-start like CI.
sed -i "/^  edge:\$/a\\    cpus: ${CPUS}" docker-compose.local-platform.yaml
rm -rf .local-platform/cache/edge/compiler_cache .local-platform/cache/edge/webc_cache

rc=0
GH_TOKEN="$GH_TOKEN" LOCAL_TEST_COMMAND="$JEST_CMD" LOCAL_PLATFORM_AUTO_DOWN=1 \
  make local-test || rc=$?

LOG=.local-platform/current/logs/compose.follow.log
echo
echo "=== verdict (test exit code: $rc) ==="
if grep -q "object used with the wrong context" "$LOG" 2>/dev/null; then
  echo "PANIC REPRODUCED:"
  grep -m1 -B1 -A4 "panicked at" "$LOG"
else
  echo "no cross-Store panic in $LOG"
  echo "retry with a tighter cap: CPUS=1 $0"
fi
