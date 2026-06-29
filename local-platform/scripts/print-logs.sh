#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

if [ -z "${RUN_DIR:-}" ]; then
  [ -d "$LOCAL_PLATFORM_DIR/current" ] || fail "No current local platform run found"
  RUN_DIR="$(cd "$LOCAL_PLATFORM_DIR/current" && pwd)"
fi

log_dir="$RUN_DIR/logs"
[ -d "$log_dir" ] || fail "No logs directory found: $log_dir"

for file in "$log_dir"/*.log "$log_dir"/*.txt; do
  [ -e "$file" ] || continue
  printf '\n===== %s =====\n' "${file#$RUN_DIR/}"
  tail -n "${LOCAL_PLATFORM_LOG_LINES:-200}" "$file" || true
done
