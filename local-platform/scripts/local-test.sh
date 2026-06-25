#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

LOCAL_PLATFORM_PREPARE_ONLY="${LOCAL_PLATFORM_PREPARE_ONLY:-0}"
REQUESTED_LOCAL_TEST_COMMAND="${LOCAL_TEST_COMMAND:-}"
STACK_READY=0
LOCAL_PLATFORM_AUTO_DOWN="${LOCAL_PLATFORM_AUTO_DOWN:-0}"

cleanup() {
  local exit_code=$?
  set +e

  if [ "$STACK_READY" -eq 1 ]; then
    if is_truthy "$LOCAL_PLATFORM_AUTO_DOWN"; then
      if [ "$exit_code" -ne 0 ] && is_truthy "${LOCAL_PLATFORM_KEEP_RUNNING_ON_FAILURE:-}"; then
        log_warn "LOCAL_PLATFORM_KEEP_RUNNING_ON_FAILURE is set; leaving the local platform running for inspection"
      else
        "$SCRIPT_DIR/down.sh" || true
      fi
    else
      log "Leaving local platform running; tear down manually with make local-platform-down"
    fi
  fi

  if [ "$exit_code" -eq 0 ]; then
    if is_truthy "$LOCAL_PLATFORM_PREPARE_ONLY"; then
      log "Prepared local platform test environment"
    else
      log "local-test passed"
    fi
  else
    if is_truthy "$LOCAL_PLATFORM_PREPARE_ONLY"; then
      log "prepare-test-environment failed with status $exit_code"
    else
      log "local-test failed with status $exit_code"
    fi
  fi

  exit "$exit_code"
}
trap cleanup EXIT

"$SCRIPT_DIR/up.sh"
STACK_READY=1
load_resolved_env
if [ -n "$REQUESTED_LOCAL_TEST_COMMAND" ]; then
  LOCAL_TEST_COMMAND="$REQUESTED_LOCAL_TEST_COMMAND"
fi

if is_truthy "$LOCAL_PLATFORM_PREPARE_ONLY"; then
  log "Local platform test environment prepared; tearing the stack down"
  exit 0
fi

log "Running tests: $LOCAL_TEST_COMMAND"
set +e
(
  set -euo pipefail
  # shellcheck disable=SC1091
  source "$RUN_DIR/test-env.sh"
  cd "$REPO_DIR"
  export VERBOSE="${VERBOSE:-false}"
  export FORCE_COLOR="${FORCE_COLOR:-1}"
  # Mirror GitHub Actions bash run-step semantics so multi-line suite commands
  # fail on the first failing command instead of returning the exit status of
  # only the last line.
  timeout "${LOCAL_PLATFORM_TEST_TIMEOUT_SECONDS:-1200}" \
    bash -lc "set -euo pipefail
$LOCAL_TEST_COMMAND"
) 2>&1 | tee "$RUN_DIR/logs/tests.log"
test_status=${PIPESTATUS[0]}
set -e

exit "$test_status"
