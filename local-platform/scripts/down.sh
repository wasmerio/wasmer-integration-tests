#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

if [ -z "${RUN_DIR:-}" ]; then
  if [ -f "$LOCAL_PLATFORM_DIR/current/resolved.env" ]; then
    RUN_DIR="$(cd "$LOCAL_PLATFORM_DIR/current" && pwd)"
  else
    fail "No current local platform run found"
  fi
fi

set_default_cache_dirs
load_resolved_env
if ! is_truthy "${LOCAL_PLATFORM_SKIP_COLLECT_ON_DOWN:-}"; then
  "$SCRIPT_DIR/collect-logs.sh" || true
fi
compose down --remove-orphans --volumes

pid_file="$RUN_DIR/logs/compose.follow.pid"
if [ -f "$pid_file" ]; then
  log_pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$log_pid" ]; then
    kill "$log_pid" >/dev/null 2>&1 || true
    wait "$log_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$pid_file"
fi
