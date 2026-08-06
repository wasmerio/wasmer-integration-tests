#!/usr/bin/env bash
# Reproduce ECO-426 — phpix 0.3.0-rc.4 (64-bit) folds unary negation to float.
# Linear: ECO-426 — https://linear.app/wasmer/issue/ECO-426
# Run from the wasmer-integration-tests repo root.
#
# Probes three phpix builds with the local wasmer runtime, no platform needed:
#
#   0.2.2      64-bit   gettype(-1) => integer   (last fleet-wide good build)
#   0.3.0-rc.3 64-bit   gettype(-1) => integer   (same PHP 8.3.31 as rc.4)
#   0.3.0-rc.4 64-bit   gettype(-1) => double    <-- the regression
#
# `1` and `0 - 1` stay int, so only negation is affected. Any `int` parameter
# with a negative default then fails to compile, which is what 500'd ~109 prod
# apps from 2026-08-05 09:20Z, when the Edge package override moved to rc.4.
#
# Knobs:
#   PKGS="a b c"  space-separated package selectors to probe
#   APP_URL=...   deployed app serving fixtures/php/int-semantics-report.php as
#                 index.php — reports what the fleet actually serves. Deploy
#                 one with: npx jest tests/app/phpix-64bit-int-semantics.test.ts
#   PORT=...      first local port; one port per package is used
set -euo pipefail

PKGS="${PKGS:-phpix/phpix-83-64bit@=0.2.2 phpix/phpix-83-64bit@=0.3.0-rc.3 phpix/phpix-83-64bit@=0.3.0-rc.4 phpix/phpix-83-32bit@=0.3.0-rc.4}"
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

# The docroot is the fixture set the jest repro deploys, so local and deployed
# runs answer the same three URLs.
mkdir -p "$WORK/src"
cp fixtures/php/int-semantics-report.php "$WORK/src/index.php"
cp fixtures/php/int-default-negative-literal.php "$WORK/src/"
cp fixtures/php/int-default-64bit-literal.php "$WORK/src/"

json_field() { grep -o "\"$2\":[^,}]*" <<<"$1" | head -1 | cut -d: -f2- | tr -d '"'; }

# Serve one package locally and report how its PHP types a negated integer.
probe_package() {
  local pkg="$1" port="$2"
  local log="$WORK/probe-$port.log"

  wasmer run "$pkg" --net --volume "$WORK/src:/src" \
    -- -S "127.0.0.1:$port" -t /src >"$log" 2>&1 &
  SERVER=$!

  local report=""
  for _ in $(seq 1 40); do
    sleep 3
    report="$(curl -sS --max-time 5 "http://127.0.0.1:$port/index.php" 2>/dev/null || true)"
    [[ -n "$report" ]] && break
  done

  if [[ -z "$report" ]]; then
    echo "  did not start — see $log"
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
    grep -aoE 'PHP Fatal error:[^<]{0,80}' "$log" | sort -u | sed 's/^/  fatal: /'
  fi

  kill "$SERVER" 2>/dev/null || true
  wait "$SERVER" 2>/dev/null || true
  SERVER=""
}

port=$PORT
for pkg in $PKGS; do
  echo "=== $pkg ==="
  probe_package "$pkg" "$port"
  echo
  port=$((port + 1))
done

echo "=== verdict ==="
echo "gettype(-1) must be 'integer' on every build above."

if [[ -n "$APP_URL" ]]; then
  echo
  echo "=== $APP_URL (served by the platform) ==="
  deployed="$(curl -sS --max-time 30 "${APP_URL%/}/index.php" 2>/dev/null || true)"
  negative_type="$(json_field "$deployed" negative_literal_type)"
  printf '  %-22s %s\n' "PHP:" "$(json_field "$deployed" php_version)"
  printf '  %-22s %s\n' "PHP_INT_SIZE:" "$(json_field "$deployed" php_int_size)"
  printf '  %-22s %s\n' "gettype(-1):" "${negative_type:-<no report>}"
  echo
  if [[ "$negative_type" == "integer" ]]; then
    echo "fleet build is sound — ECO-426 is not reproducing on $APP_URL"
  else
    echo "ECO-426 REPRODUCED on the fleet: gettype(-1) => ${negative_type:-?}"
    echo "roll the phpix package override back off 0.3.0-rc.4 for the 64-bit atoms"
  fi
else
  echo "set APP_URL=<deployed 64-bit phpix app> to check what the fleet serves"
fi
