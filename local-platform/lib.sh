#!/usr/bin/env bash

set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOCAL_PLATFORM_DIR="$REPO_DIR/.local-platform"
COMPOSE_FILE="$REPO_DIR/docker-compose.local-platform.yaml"
DEFAULT_TEST_COMMAND='pnpm exec jest ./tests/general/'

ANSI_RESET=$'\033[0m'
ANSI_DIM_GRAY=$'\033[90m'
ANSI_CYAN=$'\033[36m'
ANSI_GREEN=$'\033[32m'
ANSI_YELLOW=$'\033[33m'
ANSI_RED=$'\033[31m'
ANSI_BOLD_RED=$'\033[1;31m'

is_truthy() {
  case "${1:-}" in
    ""|0|false|False|FALSE|no|No|NO|off|Off|OFF)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

log_use_color() {
  [ -t 2 ] && [ -z "${NO_COLOR:-}" ]
}

log_is_verbose() {
  is_truthy "${VERBOSE:-}"
}

log_progress_enabled() {
  ! log_is_verbose && [ -t 2 ]
}

log_color_for_level() {
  case "$1" in
    DEBUG) printf '%s' "$ANSI_CYAN" ;;
    INFO) printf '%s' "$ANSI_GREEN" ;;
    WARNING) printf '%s' "$ANSI_YELLOW" ;;
    ERROR) printf '%s' "$ANSI_RED" ;;
    CRITICAL) printf '%s' "$ANSI_BOLD_RED" ;;
    *) printf '' ;;
  esac
}

log_clear() {
  if log_progress_enabled; then
    printf '\r\033[K' >&2
  fi
}

log_emit() {
  local level="$1"
  shift
  local message="$*"

  if [ "$level" = "DEBUG" ] && ! log_is_verbose; then
    return 0
  fi

  if log_progress_enabled && { [ "$level" = "INFO" ] || [ "$level" = "DEBUG" ]; }; then
    local width rendered
    width="$(tput cols 2>/dev/null || printf '120')"
    rendered="[local-platform] $message"
    rendered="${rendered:0:$((width > 1 ? width - 1 : 80))}"
    if log_use_color; then
      rendered="${ANSI_DIM_GRAY}${rendered}${ANSI_RESET}"
    fi
    printf '\r\033[K%s' "$rendered" >&2
    return 0
  fi

  log_clear
  local timestamp rendered_level
  timestamp="$(date '+%H:%M:%S')"
  rendered_level="$(printf '%-7s' "$level")"
  if log_use_color; then
    local color
    color="$(log_color_for_level "$level")"
    [ -n "$color" ] && rendered_level="${color}${rendered_level}${ANSI_RESET}"
  fi
  printf '%s %s %s\n' "$timestamp" "$rendered_level" "$message" >&2
}

log() {
  log_emit INFO "$@"
}

log_debug() {
  log_emit DEBUG "$@"
}

log_warn() {
  log_emit WARNING "$@"
}

fail() {
  log_emit ERROR "$*"
  exit 1
}

is_ci() {
  [ "${CI:-}" = "true" ] || [ -n "${GITHUB_ACTIONS:-}" ]
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

set_default_cache_dirs() {
  : "${LOCAL_PLATFORM_PACKAGE_CACHE_DIR:=$LOCAL_PLATFORM_DIR/package-cache}"
  : "${LOCAL_PLATFORM_EDGE_CACHE_DIR:=$LOCAL_PLATFORM_DIR/cache/edge}"
  export LOCAL_PLATFORM_PACKAGE_CACHE_DIR LOCAL_PLATFORM_EDGE_CACHE_DIR
}

set_default_ports() {
  : "${BACKEND_HTTP_PORT:=18000}"
  : "${EDGE_HTTP_PORT:=19080}"
  : "${EDGE_HTTPS_PORT:=19443}"
  : "${EDGE_NODE_API_PORT:=19050}"
  : "${EDGE_GRPC_PORT:=19051}"
  : "${EDGE_SSH_PORT:=19022}"
  : "${EDGE_DNS_PORT:=19053}"
  : "${POSTGRES_PORT:=15432}"
  : "${REDIS_PORT:=16379}"
  : "${MYSQL_APP_DB_1_PORT:=13306}"
  : "${MYSQL_APP_DB_2_PORT:=13307}"
  : "${MINIO_PERSISTENT_API_PORT:=19100}"
  : "${MINIO_PERSISTENT_CONSOLE_PORT:=19101}"
  : "${CLICKHOUSE_HTTP_PORT:=18123}"
  : "${CLICKHOUSE_NATIVE_PORT:=19123}"
  : "${LOKI_PORT:=13100}"
  : "${VECTOR_HTTP_PORT:=19089}"
  export BACKEND_HTTP_PORT EDGE_HTTP_PORT EDGE_HTTPS_PORT EDGE_NODE_API_PORT EDGE_GRPC_PORT EDGE_SSH_PORT EDGE_DNS_PORT
  export POSTGRES_PORT REDIS_PORT MYSQL_APP_DB_1_PORT MYSQL_APP_DB_2_PORT
  export MINIO_PERSISTENT_API_PORT MINIO_PERSISTENT_CONSOLE_PORT CLICKHOUSE_HTTP_PORT CLICKHOUSE_NATIVE_PORT LOKI_PORT VECTOR_HTTP_PORT
}

port_is_listening() {
  local port="$1"
  (echo > "/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1
}

port_owner_hint() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -n 3 || true
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep -E "[:.]$port[[:space:]]" | head -n 3 || true
  fi

  if command -v docker >/dev/null 2>&1; then
    docker ps --format '{{.ID}} {{.Names}} {{.Ports}}' 2>/dev/null \
      | grep -E "(^|[^0-9])$port([^0-9]|$)" \
      | head -n 3 || true
  fi
}

check_tcp_port_available() {
  local var_name="$1"
  local service="$2"
  local port="${!var_name}"

  if port_is_listening "$port"; then
    local owner
    owner="$(port_owner_hint "$port")"
    if [ -n "$owner" ]; then
      log_warn "Port $port for $service is already in use:"
      printf '%s\n' "$owner" >&2
    fi
    fail "Port $port for $service is already allocated. Stop the process using it or rerun with $var_name=<free-port>."
  fi
}

check_required_ports_available() {
  set_default_ports
  check_tcp_port_available BACKEND_HTTP_PORT "Backend HTTP"
  check_tcp_port_available EDGE_HTTP_PORT "Edge HTTP"
  check_tcp_port_available EDGE_HTTPS_PORT "Edge HTTPS"
  check_tcp_port_available EDGE_NODE_API_PORT "Edge Node API"
  check_tcp_port_available EDGE_GRPC_PORT "Edge gRPC"
  check_tcp_port_available EDGE_SSH_PORT "Edge SSH/SFTP"
  check_tcp_port_available POSTGRES_PORT "Postgres"
  check_tcp_port_available REDIS_PORT "Redis"
  check_tcp_port_available MYSQL_APP_DB_1_PORT "MySQL app DB 1"
  check_tcp_port_available MYSQL_APP_DB_2_PORT "MySQL app DB 2"
  check_tcp_port_available MINIO_PERSISTENT_API_PORT "MinIO persistent API"
  check_tcp_port_available MINIO_PERSISTENT_CONSOLE_PORT "MinIO persistent console"
  check_tcp_port_available CLICKHOUSE_HTTP_PORT "ClickHouse HTTP"
  check_tcp_port_available CLICKHOUSE_NATIVE_PORT "ClickHouse native"
  check_tcp_port_available LOKI_PORT "Loki"
  check_tcp_port_available VECTOR_HTTP_PORT "Vector HTTP"
}

compose() {
  docker compose --project-name "$COMPOSE_PROJECT_NAME" --file "$COMPOSE_FILE" "$@"
}

json_quote() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1] ?? ""))' "$1"
}

write_env_var() {
  local file="$1"
  local name="$2"
  local value="$3"
  printf 'export %s=%q\n' "$name" "$value" >> "$file"
}

current_run_dir() {
  if [ -L "$LOCAL_PLATFORM_DIR/current" ] || [ -d "$LOCAL_PLATFORM_DIR/current" ]; then
    cd "$LOCAL_PLATFORM_DIR/current" && pwd
  fi
}

compose_project_has_running_containers() {
  [ -n "${COMPOSE_PROJECT_NAME:-}" ] || fail "COMPOSE_PROJECT_NAME is required"
  docker ps \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --format '{{.Names}}' | grep -q .
}

compose_service_is_running() {
  local service="$1"
  [ -n "${COMPOSE_PROJECT_NAME:-}" ] || fail "COMPOSE_PROJECT_NAME is required"
  docker ps \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --filter "label=com.docker.compose.service=$service" \
    --format '{{.Names}}' | grep -q .
}

process_is_running() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
}

load_resolved_env() {
  if [ -z "${RUN_DIR:-}" ]; then
    if [ -L "$LOCAL_PLATFORM_DIR/current" ] || [ -d "$LOCAL_PLATFORM_DIR/current" ]; then
      RUN_DIR="$(cd "$LOCAL_PLATFORM_DIR/current" && pwd)"
    else
      fail "RUN_DIR is not set and .local-platform/current does not exist"
    fi
  fi

  export RUN_DIR
  [ -f "$RUN_DIR/resolved.env" ] || fail "Missing resolved env: $RUN_DIR/resolved.env"
  # shellcheck disable=SC1091
  source "$RUN_DIR/resolved.env"
}
