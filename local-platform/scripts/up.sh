#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

require_cmd docker
require_cmd node

start_compose_log_follow() {
  local pid_file="$RUN_DIR/logs/compose.follow.pid"
  local existing_pid=""
  if [ -f "$pid_file" ]; then
    existing_pid="$(cat "$pid_file" 2>/dev/null || true)"
  fi

  if process_is_running "$existing_pid"; then
    LOG_FOLLOW_PID="$existing_pid"
    return 0
  fi

  nohup docker compose --project-name "$COMPOSE_PROJECT_NAME" --file "$COMPOSE_FILE" logs --no-color --timestamps --follow \
    > "$RUN_DIR/logs/compose.follow.log" 2>&1 &
  LOG_FOLLOW_PID=$!
  printf '%s\n' "$LOG_FOLLOW_PID" > "$pid_file"
}

generated_test_env_var() {
  local var_name="$1"
  [ -f "$RUN_DIR/test-env.sh" ] || return 1
  bash -lc "set -a; source \"$RUN_DIR/test-env.sh\"; set +a; printf '%s' \"\${$var_name:-}\""
}

resolved_env_var() {
  local env_file="$1"
  local var_name="$2"
  [ -f "$env_file" ] || return 1
  bash -lc "set -a; source \"$env_file\"; set +a; printf '%s' \"\${$var_name:-}\""
}

local_admin_username() {
  local whoami_output username
  whoami_output="$(bash -lc "set -a; source \"$RUN_DIR/test-env.sh\"; set +a; wasmer whoami" 2>/dev/null || true)"
  username="$(printf '%s' "$whoami_output" | sed -n 's/^Logged into registry .* as user \([^[:space:]]\+\)$/\1/p' | head -n1)"
  if [ -n "$username" ]; then
    printf '%s' "$username"
    return 0
  fi

  printf 'local-dev'
}

print_access_summary() {
  local admin_username admin_token
  admin_username="$(local_admin_username)"
  admin_token="$(generated_test_env_var WASMER_TOKEN || true)"

  local reset="" dim="" cyan="" green="" yellow="" bold=""
  local rule="────────────────────────────────────────────────────────────────────────────"
  if log_use_color; then
    reset="$ANSI_RESET"
    dim="$ANSI_DIM_GRAY"
    cyan="$ANSI_CYAN"
    green="$ANSI_GREEN"
    yellow="$ANSI_YELLOW"
    bold=$'\033[1m'
  fi

  log_clear
  cat >&2 <<EOF

${bold}${cyan}Local platform is running${reset}
${cyan}${rule}${reset}

${cyan}┌${rule}${reset}
${cyan}│${reset} ${bold}Run directory${reset}
${cyan}│${reset} ${RUN_DIR}
${cyan}│${reset} Current env: ${dim}source ${RUN_DIR}/test-env.sh${reset}
${cyan}└${rule}${reset}

${cyan}┌${rule}${reset}
${cyan}│${reset} ${bold}How to use it${reset}
${cyan}│${reset} ${dim}Load local env (sets WASMER_REGISTRY, WASMER_TOKEN, EDGE_SERVER, etc.)${reset}
${cyan}│${reset}   ${green}source ${RUN_DIR}/test-env.sh${reset}
${cyan}│${reset} ${dim}Run a targeted local test${reset}
${cyan}│${reset}   ${green}pnpm exec jest tests/validation/log.test.ts --runInBand${reset}
${cyan}│${reset} ${dim}Inspect apps / auth${reset}
${cyan}│${reset}   ${green}wasmer app list${reset}
${cyan}│${reset}   ${green}wasmer whoami${reset}
${cyan}│${reset} ${dim}Local admin${reset} user=${yellow}${admin_username}${reset} token=${yellow}${admin_token}${reset}
${cyan}│${reset} ${dim}Key env${reset} WASMER_REGISTRY=${green}http://localhost:${BACKEND_HTTP_PORT}/graphql${reset} EDGE_SERVER=${green}http://127.0.0.1:${EDGE_HTTP_PORT}${reset}
${cyan}│${reset} ${dim}Stop everything${reset}
${cyan}│${reset}   ${yellow}make local-platform-down${reset}
${cyan}└${rule}${reset}

${cyan}┌${rule}${reset}
${cyan}│${reset} ${bold}Primary endpoints${reset}
${cyan}│${reset} ${dim}Backend GraphQL / registry${reset} ${green}http://localhost:${BACKEND_HTTP_PORT}/graphql${reset}
${cyan}│${reset} ${dim}Edge HTTP                 ${reset} ${green}http://127.0.0.1:${EDGE_HTTP_PORT}${reset}
${cyan}│${reset} ${dim}Edge HTTPS                ${reset} ${green}https://127.0.0.1:${EDGE_HTTPS_PORT}${reset}
${cyan}│${reset} ${dim}Edge SSH                  ${reset} ${green}ssh://127.0.0.1:${EDGE_SSH_PORT}${reset}
${cyan}│${reset} ${dim}Edge DNS                  ${reset} ${green}127.0.0.1:${EDGE_DNS_PORT}${reset}
${cyan}└${rule}${reset}

${cyan}┌${rule}${reset}
${cyan}│${reset} ${bold}Observability and services${reset}
${cyan}│${reset} ${dim}Compose logs${reset}   ${RUN_DIR}/logs/compose.follow.log
${cyan}│${reset} ${dim}Follow logs${reset}   ${yellow}make local-platform-logs${reset}
${cyan}│${reset} ${dim}Loki${reset}           ${green}http://localhost:${LOKI_PORT}${reset}
${cyan}│${reset} ${dim}Vector${reset}         ${green}http://127.0.0.1:${VECTOR_HTTP_PORT}${reset}
${cyan}│${reset} ${dim}ClickHouse${reset}     ${green}http://localhost:${CLICKHOUSE_HTTP_PORT}${reset} ${dim}(db=${yellow}edge_metrics_local${reset}${dim} user=${yellow}default${reset}${dim} password=${yellow}root${reset}${dim})${reset}
${cyan}│${reset} ${dim}Postgres${reset}       localhost:${POSTGRES_PORT} ${dim}(db=${yellow}wapm${reset}${dim} user=${yellow}postgres${reset}${dim} password=${yellow}postgres${reset}${dim})${reset}
${cyan}│${reset} ${dim}Redis${reset}          localhost:${REDIS_PORT}
${cyan}│${reset} ${dim}MySQL app DB${reset}   localhost:${MYSQL_APP_DB_1_PORT} ${dim}(user=${yellow}root${reset}${dim} password=${yellow}root${reset}${dim})${reset}
${cyan}└${rule}${reset}

EOF
}

reuse_existing_run_if_running() {
  local existing_run_dir existing_resolved_env existing_backend_version existing_edge_version
  existing_run_dir="$(current_run_dir || true)"
  [ -n "$existing_run_dir" ] || return 1
  existing_resolved_env="$existing_run_dir/resolved.env"
  [ -f "$existing_resolved_env" ] || return 1

  existing_backend_version="$(resolved_env_var "$existing_resolved_env" BACKEND_VERSION || true)"
  existing_edge_version="$(resolved_env_var "$existing_resolved_env" EDGE_VERSION || true)"

  if [ "$existing_backend_version" != "$BACKEND_VERSION" ] || [ "$existing_edge_version" != "$EDGE_VERSION" ]; then
    log "Stopping existing local platform run because the requested selectors changed"
    log "Existing selectors: backend=$existing_backend_version edge=$existing_edge_version"
    log "Requested selectors: backend=$BACKEND_VERSION edge=$EDGE_VERSION"
    RUN_DIR="$existing_run_dir"
    export RUN_DIR
    # shellcheck disable=SC1090
    source "$existing_resolved_env"
    LOCAL_PLATFORM_SKIP_COLLECT_ON_DOWN=1 "$SCRIPT_DIR/down.sh"
    return 1
  fi

  RUN_DIR="$existing_run_dir"
  export RUN_DIR
  # shellcheck disable=SC1090
  source "$RUN_DIR/resolved.env"

  if ! compose_project_has_running_containers; then
    return 1
  fi

  mkdir -p "$RUN_DIR/logs"
  log "Reusing existing local platform run: $RUN_DIR"

  if compose_service_is_running backend && compose_service_is_running edge; then
    start_compose_log_follow
    print_access_summary
    return 0
  fi

  log "Found a partially running Compose project; ensuring services are up"
  compose up -d \
    postgres redis \
    mysql_app_db_1 mysql_app_db_2 \
    minio_persistent minio_persistent_init \
    clickhouse loki vector
  compose up -d backend
  node "$REPO_DIR/local-platform/scripts/wait-url.mjs" "http://localhost:${BACKEND_HTTP_PORT}/graphql" "${LOCAL_PLATFORM_BACKEND_TIMEOUT_MS:-120000}"
  compose up -d edge
  node "$REPO_DIR/local-platform/scripts/wait-url.mjs" "http://127.0.0.1:${EDGE_HTTP_PORT}/" "${LOCAL_PLATFORM_EDGE_TIMEOUT_MS:-120000}"

  start_compose_log_follow

  print_access_summary
  return 0
}

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
fi

[ -n "${BACKEND_VERSION:-}" ] || fail "BACKEND_VERSION is required"
[ -n "${EDGE_VERSION:-}" ] || fail "EDGE_VERSION is required"
set_default_ports
set_default_cache_dirs

if reuse_existing_run_if_running; then
  exit 0
fi

check_required_ports_available

short_sha="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || printf local)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$LOCAL_PLATFORM_DIR/runs/${timestamp}-${short_sha}"
COMPOSE_PROJECT_NAME="wit_${timestamp}_${short_sha}"
COMPOSE_PROJECT_NAME="$(printf '%s' "$COMPOSE_PROJECT_NAME" | tr '[:upper:]-' '[:lower:]_')"
export RUN_DIR COMPOSE_PROJECT_NAME BACKEND_VERSION EDGE_VERSION

mkdir -p \
  "$RUN_DIR/logs" \
  "$RUN_DIR/diagnostics" \
  "$RUN_DIR/edge" \
  "$RUN_DIR/artifacts" \
  "$LOCAL_PLATFORM_DIR" \
  "$LOCAL_PLATFORM_PACKAGE_CACHE_DIR" \
  "$LOCAL_PLATFORM_EDGE_CACHE_DIR/compiler_cache" \
  "$LOCAL_PLATFORM_EDGE_CACHE_DIR/webc_cache"
ln -sfn "runs/$(basename "$RUN_DIR")" "$LOCAL_PLATFORM_DIR/current"
touch "$RUN_DIR/backend.env" "$RUN_DIR/edge/platform_config.yaml"

log "Run directory: $RUN_DIR"
log "Requested versions: backend=$BACKEND_VERSION edge=$EDGE_VERSION"

require_github_token=0
case "$BACKEND_VERSION" in
  artifact:*|github-artifact:*|github-release:*|resolve_dev|latest_dev|latest-dev) require_github_token=1 ;;
esac
case "$EDGE_VERSION" in
  github-artifact:*|github-release:*|resolve_prod|resolve_dev|latest_dev|latest-dev) require_github_token=1 ;;
esac

if [ "$require_github_token" -eq 1 ]; then
  ensure_github_token
fi

if is_truthy "${LOCAL_PLATFORM_ARTIFACT_FETCH_PAT_PRESENT:-}"; then
  log "Custom artifact fetch PAT is present for private artifact/release fetches"
elif [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
  log "GitHub token is available for artifact/release fetches"
else
  log_warn "No GitHub token is available; private artifact/release fetches may fail"
fi

LOG_FOLLOW_PID=""
UP_SUCCEEDED=0
cleanup() {
  local exit_code=$?
  set +e
  if [ "$exit_code" -eq 0 ] && [ "$UP_SUCCEEDED" -eq 1 ]; then
    return 0
  fi
  if [ -n "$LOG_FOLLOW_PID" ]; then
    kill "$LOG_FOLLOW_PID" >/dev/null 2>&1 || true
    wait "$LOG_FOLLOW_PID" >/dev/null 2>&1 || true
    rm -f "$RUN_DIR/logs/compose.follow.pid"
  fi
  if [ -f "$RUN_DIR/resolved.env" ]; then
    "$SCRIPT_DIR/collect-logs.sh" || true
    if is_truthy "${LOCAL_PLATFORM_KEEP_RUNNING_ON_FAILURE:-}" || ! is_truthy "${LOCAL_PLATFORM_AUTO_DOWN:-0}"; then
      log_warn "Leaving Compose project $COMPOSE_PROJECT_NAME running for inspection"
    else
      LOCAL_PLATFORM_SKIP_COLLECT_ON_DOWN=1 "$SCRIPT_DIR/down.sh" || true
    fi
  fi
  log "local-platform-up failed with status $exit_code; run retained at $RUN_DIR"
  exit "$exit_code"
}
trap cleanup EXIT

log "Resolving concrete Backend/Edge versions"
"$SCRIPT_DIR/resolve.sh"
# shellcheck disable=SC1091
source "$RUN_DIR/resolved.env"
log "Resolved versions: backend_image_ref=$BACKEND_IMAGE_REF backend_image_source=${BACKEND_IMAGE_SOURCE:-<registry-pull>} edge=$EDGE_RESOLVED"
log "Fetching resolved artifacts and images"
"$SCRIPT_DIR/fetch-artifacts.sh"

log "Starting dependency services"
compose up -d \
  postgres redis \
  mysql_app_db_1 mysql_app_db_2 \
  minio_persistent minio_persistent_init \
  clickhouse loki vector

start_compose_log_follow

log "Running backend migrations"
run_quietly "Backend migrations" "$RUN_DIR/logs/backend-migrate.log" \
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
    run_quietly "Package seeding" "$RUN_DIR/logs/package-seed.log" \
      node "$REPO_DIR/local-platform/scripts/seed-packages.mjs" "$REPO_DIR" "$RUN_DIR"
  )
else
  log "Skipping package dependency seeding because LOCAL_PLATFORM_SEED_PACKAGES=${LOCAL_PLATFORM_SEED_PACKAGES:-}"
fi

log "Persisting Relay queries (if any)"
run_quietly "Relay query persistence" "$RUN_DIR/logs/persist-relay-queries.log" \
  node "$REPO_DIR/local-platform/scripts/persist-relay-queries.mjs" \
    "$RUN_DIR/artifacts/relay-persisted-queries.json" \
    "http://localhost:${BACKEND_HTTP_PORT}/graphql/persist"

"$SCRIPT_DIR/ensure-compiled.sh"

log "Starting Edge"
compose up -d edge
node "$REPO_DIR/local-platform/scripts/wait-url.mjs" "http://127.0.0.1:${EDGE_HTTP_PORT}/" "${LOCAL_PLATFORM_EDGE_TIMEOUT_MS:-120000}"

UP_SUCCEEDED=1
print_access_summary
