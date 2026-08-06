#!/usr/bin/env bash
# Reproduce ECO-426 — phpix 0.3.0-rc.4 (64-bit) folds unary negation to float.
# Linear: ECO-426 — https://linear.app/wasmer/issue/ECO-426
# Run from the wasmer-integration-tests repo root.
#
# Serves the same three fixture files over the same HTTP path first with the
# host's native PHP, then with each phpix build under wasmer, so the only
# variable between runs is the engine. Native is the control: `gettype(-1)`
# must be `integer` everywhere.
#
#   native php              gettype(-1) => integer
#   0.2.2      64-bit       gettype(-1) => integer   (last fleet-wide good build)
#   0.3.0-rc.3 64-bit       gettype(-1) => integer   (same PHP 8.3.31 as rc.4)
#   0.3.0-rc.4 64-bit       gettype(-1) => double    <-- the regression
#   0.3.0-rc.4 32-bit       gettype(-1) => integer
#
# `1` and `0 - 1` stay int, so only negation is affected. Any `int` parameter
# with a negative default then fails to compile, which is what 500'd ~109 prod
# apps from 2026-08-05 09:20Z, when the Edge package override moved to rc.4.
#
# Knobs:
#   PKGS="a b c"  space-separated phpix selectors to probe after native
#   PHP_BIN=php   native PHP binary used for the control run
#   APP_URL=...   deployed app serving fixtures/php/int-semantics-report.php as
#                 index.php — adds what the fleet actually serves to the
#                 verdict. Deploy one with:
#                 npx jest tests/app/phpix-64bit-int-semantics.test.ts
#   PORT=...      first local port; one port per engine is used
set -euo pipefail

PKGS="${PKGS:-phpix/phpix-83-64bit@=0.2.2 phpix/phpix-83-64bit@=0.3.0-rc.3 phpix/phpix-83-64bit@=0.3.0-rc.4 phpix/phpix-83-32bit@=0.3.0-rc.4}"
PHP_BIN="${PHP_BIN:-php}"
PORT="${PORT:-18940}"
APP_URL="${APP_URL:-}"

[[ -d fixtures/php && -f Makefile ]] ||
  { echo "error: run from the wasmer-integration-tests repo root" >&2; exit 1; }
command -v wasmer >/dev/null ||
  { echo "error: wasmer CLI not on PATH" >&2; exit 1; }

WORK="$(mktemp -d)"
SERVER=""
cleanup() {
  [[ -n "$SERVER" ]] && kill "$SERVER" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# The docroot is the fixture set the jest repro deploys, so this script and
# `npx jest tests/app/phpix-64bit-int-semantics.test.ts` answer the same URLs.
mkdir -p "$WORK/src"
cp fixtures/php/int-semantics-report.php "$WORK/src/index.php"
cp fixtures/php/int-default-negative-literal.php "$WORK/src/"
cp fixtures/php/int-default-64bit-literal.php "$WORK/src/"
SUMMARY="$WORK/summary.tsv"

json_field() { grep -o "\"$2\":[^,}]*" <<<"$1" | head -1 | cut -d: -f2- | tr -d '"'; }

# Serve the docroot with one engine and report how its PHP types a negated
# integer. The engine command is passed in; everything else is identical.
probe_engine() {
  local label="$1" port="$2"
  shift 2
  local log="$WORK/probe-$port.log"

  "$@" >"$log" 2>&1 &
  SERVER=$!

  local report=""
  for _ in $(seq 1 40); do
    sleep 3
    report="$(curl -sS --max-time 5 "http://127.0.0.1:$port/index.php" 2>/dev/null || true)"
    [[ -n "$report" ]] && break
  done

  echo "=== $label ==="
  if [[ -z "$report" ]]; then
    echo "  did not start — see $log"
    printf '%s\t%s\t%s\n' "$label" "-" "-" >>"$SUMMARY"
  else
    # A parse-time failure returns no body, so the compile probe is judged on
    # the response, not on anything catchable inside PHP.
    local negative
    negative="$(curl -sS --max-time 10 "http://127.0.0.1:$port/int-default-negative-literal.php" 2>/dev/null |
      tr -d '\n' | sed -e 's/<[^>]*>//g' -e 's/^ *//' | cut -c1-110 || true)"

    printf '  %-22s %s\n' "PHP:" "$(json_field "$report" php_version)"
    printf '  %-22s %s\n' "PHP_INT_SIZE:" "$(json_field "$report" php_int_size)"
    printf '  %-22s %s\n' "gettype(1):" "$(json_field "$report" positive_literal_type)"
    printf '  %-22s %s\n' "gettype(-1):" "$(json_field "$report" negative_literal_type)"
    printf '  %-22s %s\n' "gettype(-\$x):" "$(json_field "$report" negated_variable_type)"
    printf '  %-22s %s\n' "gettype(0 - 1):" "$(json_field "$report" subtraction_type)"
    printf '  %-22s %s\n' "int \$n = -1:" "${negative:-<no output — fatal>}"
    # No match is the healthy case, and `pipefail` would abort the run.
    { grep -aoE 'PHP Fatal error:[^<]{0,80}' "$log" || true; } | sort -u | sed 's/^/  fatal: /'
    printf '%s\t%s\t%s\n' \
      "$label" "$(json_field "$report" negative_literal_type)" "$(json_field "$report" php_version)" >>"$SUMMARY"
  fi

  kill "$SERVER" 2>/dev/null || true
  wait "$SERVER" 2>/dev/null || true
  SERVER=""
  echo
}

# Native first: the control the wasmer runs are judged against.
port=$PORT
if command -v "$PHP_BIN" >/dev/null; then
  probe_engine "native $($PHP_BIN -r 'echo PHP_VERSION;') (host $PHP_BIN)" "$port" \
    "$PHP_BIN" -S "127.0.0.1:$port" -t "$WORK/src"
else
  echo "=== native PHP ==="
  echo "  $PHP_BIN not on PATH — no control run (set PHP_BIN=...)"
  echo
fi

for pkg in $PKGS; do
  port=$((port + 1))
  probe_engine "$pkg" "$port" \
    wasmer run "$pkg" --net --volume "$WORK/src:/src" -- -S "127.0.0.1:$port" -t /src
done

echo "=== verdict ==="
native_type="$(awk -F'\t' '/^native/ {print $2; exit}' "$SUMMARY" 2>/dev/null || true)"
bad="$(awk -F'\t' '$1 !~ /^native/ && $2 != "integer" && $2 != "-" {print "  " $1 " => " $2}' "$SUMMARY" 2>/dev/null || true)"

if [[ -n "$native_type" && "$native_type" != "integer" ]]; then
  echo "control is broken: native PHP typed -1 as '$native_type' — fix the host PHP first"
elif [[ -n "$bad" ]]; then
  echo "ECO-426 REPRODUCED — native PHP types -1 as integer, these builds do not:"
  echo "$bad"
  echo "roll the phpix package override off the affected build for the 64-bit atoms"
else
  echo "every probed build matches native PHP — ECO-426 is not reproducing here"
  echo "retry against the shipped build: PKGS=phpix/phpix-83-64bit@=0.3.0-rc.4 $0"
fi

if [[ -n "$APP_URL" ]]; then
  echo
  echo "=== $APP_URL (served by the platform) ==="
  deployed="$(curl -sS --max-time 30 "${APP_URL%/}/index.php" 2>/dev/null || true)"
  deployed_type="$(json_field "$deployed" negative_literal_type)"
  printf '  %-22s %s\n' "PHP:" "$(json_field "$deployed" php_version)"
  printf '  %-22s %s\n' "PHP_INT_SIZE:" "$(json_field "$deployed" php_int_size)"
  printf '  %-22s %s\n' "gettype(-1):" "${deployed_type:-<no report>}"
  if [[ "$deployed_type" != "integer" ]]; then
    echo "  the fleet is serving a broken build to this app"
  fi
else
  echo
  echo "set APP_URL=<deployed 64-bit phpix app> to also check what the fleet serves"
fi
