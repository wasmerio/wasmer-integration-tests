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

load_resolved_env
compose down --remove-orphans --volumes
