#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

require_cmd docker
require_cmd node

if [ -f "$REPO_DIR/local.env" ]; then
  log "Loading local.env"
  set -a
  # shellcheck disable=SC1091
  source "$REPO_DIR/local.env"
  set +a
fi

if ! is_ci; then
  BACKEND_VERSION="${BACKEND_VERSION:-resolve_prod}"
  EDGE_VERSION="${EDGE_VERSION:-resolve_prod}"
  FRONTEND_VERSION="${FRONTEND_VERSION:-resolve_prod}"
  LOCAL_TEST_COMMAND="${LOCAL_TEST_COMMAND:-$DEFAULT_TEST_COMMAND}"
fi

[ -n "${BACKEND_VERSION:-}" ] || fail "BACKEND_VERSION is required"
[ -n "${EDGE_VERSION:-}" ] || fail "EDGE_VERSION is required"
[ -n "${FRONTEND_VERSION:-}" ] || fail "FRONTEND_VERSION is required"
LOCAL_TEST_COMMAND="${LOCAL_TEST_COMMAND:-$DEFAULT_TEST_COMMAND}"
set_default_ports
check_required_ports_available

short_sha="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || printf local)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$LOCAL_PLATFORM_DIR/runs/${timestamp}-${short_sha}"
COMPOSE_PROJECT_NAME="wit_${timestamp}_${short_sha}"
COMPOSE_PROJECT_NAME="$(printf '%s' "$COMPOSE_PROJECT_NAME" | tr '[:upper:]-' '[:lower:]_')"
export RUN_DIR COMPOSE_PROJECT_NAME BACKEND_VERSION EDGE_VERSION FRONTEND_VERSION LOCAL_TEST_COMMAND

mkdir -p "$RUN_DIR/logs" "$RUN_DIR/diagnostics" "$RUN_DIR/edge" "$RUN_DIR/artifacts" "$LOCAL_PLATFORM_DIR"
ln -sfn "runs/$(basename "$RUN_DIR")" "$LOCAL_PLATFORM_DIR/current"
touch "$RUN_DIR/backend.env" "$RUN_DIR/edge/platform_config.yaml"

log "Run directory: $RUN_DIR"
log "Requested versions: backend=$BACKEND_VERSION edge=$EDGE_VERSION frontend=$FRONTEND_VERSION"
if is_truthy "${LOCAL_PLATFORM_ARTIFACT_FETCH_PAT_PRESENT:-}"; then
  log "Custom artifact fetch PAT is present for private artifact/release fetches"
elif [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
  log_warn "Using default GitHub token; it may not access private wasmerio/edge or wasmerio/backend artifacts"
else
  log_warn "No GitHub token is available; private artifact/release fetches may fail"
fi

LOG_FOLLOW_PID=""
cleanup() {
  local exit_code=$?
  set +e
  if [ -n "$LOG_FOLLOW_PID" ]; then
    kill "$LOG_FOLLOW_PID" >/dev/null 2>&1 || true
    wait "$LOG_FOLLOW_PID" >/dev/null 2>&1 || true
  fi
  if [ -f "$RUN_DIR/resolved.env" ]; then
    "$SCRIPT_DIR/collect-logs.sh" || true
    if [ "$exit_code" -ne 0 ] && is_truthy "${LOCAL_PLATFORM_KEEP_RUNNING_ON_FAILURE:-}"; then
      log_warn "LOCAL_PLATFORM_KEEP_RUNNING_ON_FAILURE is set; leaving Compose project $COMPOSE_PROJECT_NAME running for inspection"
    else
      LOCAL_PLATFORM_SKIP_COLLECT_ON_DOWN=1 "$SCRIPT_DIR/down.sh" || true
    fi
  fi
  if [ "$exit_code" -eq 0 ]; then
    log "local-test passed; logs retained at $RUN_DIR"
  else
    log "local-test failed with status $exit_code; run retained at $RUN_DIR"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

log "Resolving concrete Backend/Edge/Frontend versions"
"$SCRIPT_DIR/resolve.sh"
# shellcheck disable=SC1091
source "$RUN_DIR/resolved.env"
log "Resolved versions: backend_image_ref=$BACKEND_IMAGE_REF backend_image_source=${BACKEND_IMAGE_SOURCE:-<registry-pull>} edge=$EDGE_RESOLVED frontend=$FRONTEND_RESOLVED"
log "Fetching resolved artifacts and images"
"$SCRIPT_DIR/fetch-artifacts.sh"

log "Starting dependency services"
compose up -d \
  postgres redis \
  mysql_app_db_1 mysql_app_db_2 \
  minio_persistent minio_persistent_init \
  clickhouse loki vector

compose logs --no-color --timestamps --follow > "$RUN_DIR/logs/compose.follow.log" 2>&1 &
LOG_FOLLOW_PID=$!

log "Running backend migrations"
timeout "${LOCAL_PLATFORM_MIGRATE_TIMEOUT_SECONDS:-300}" \
  docker run --rm \
    --network "${COMPOSE_PROJECT_NAME}_default" \
    -e AWS_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/wapm \
    -e DATABASE_URL=postgresql://postgres:postgres@postgres:5432/wapm \
    -e RUST_LOG=info \
    --entrypoint /app/smbe \
    "$BACKEND_IMAGE_REF" \
    db migrate up

"$SCRIPT_DIR/bootstrap.sh"

log "Starting backend"
compose up -d backend
node "$REPO_DIR/local-platform/scripts/wait-url.mjs" "http://localhost:${BACKEND_HTTP_PORT}/graphql" "${LOCAL_PLATFORM_BACKEND_TIMEOUT_MS:-120000}"

if is_truthy "${LOCAL_PLATFORM_SEED_PACKAGES:-1}"; then
  log "Seeding package dependencies into local registry"
  (
    set -euo pipefail
    # shellcheck disable=SC1091
    source "$RUN_DIR/test-env.sh"
    node "$REPO_DIR/local-platform/scripts/seed-packages.mjs" "$REPO_DIR" "$RUN_DIR"
  )
else
  log "Skipping package dependency seeding because LOCAL_PLATFORM_SEED_PACKAGES=${LOCAL_PLATFORM_SEED_PACKAGES:-}"
fi

log "Persisting Relay queries (if any)"
node "$REPO_DIR/local-platform/scripts/persist-relay-queries.mjs" \
  "$RUN_DIR/artifacts/relay-persisted-queries.json" \
  "http://localhost:${BACKEND_HTTP_PORT}/graphql/persist"

"$SCRIPT_DIR/ensure-compiled.sh"

log "Starting Edge"
compose up -d edge
node "$REPO_DIR/local-platform/scripts/wait-url.mjs" "http://127.0.0.1:${EDGE_HTTP_PORT}/" "${LOCAL_PLATFORM_EDGE_TIMEOUT_MS:-120000}"

if [ -n "${FRONTEND_IMAGE_REF:-}" ]; then
  log "Starting frontend image $FRONTEND_IMAGE_REF"
  compose --profile frontend up -d frontend
else
  log "No FRONTEND_IMAGE_REF set; skipping frontend container"
fi

log "Running tests: $LOCAL_TEST_COMMAND"
set +e
(
  set -euo pipefail
  # shellcheck disable=SC1091
  source "$RUN_DIR/test-env.sh"
  cd "$REPO_DIR"
  timeout "${LOCAL_PLATFORM_TEST_TIMEOUT_SECONDS:-1200}" bash -lc "$LOCAL_TEST_COMMAND"
) 2>&1 | tee "$RUN_DIR/logs/tests.log"
test_status=${PIPESTATUS[0]}
set -e

exit "$test_status"
