#!/usr/bin/env bash
# End-to-end check for seed binding (phase 3, AC-1/AC-2): boots a disposable
# platform unseeded via the LOCAL_PLATFORM_SCENARIOS override, seeds a
# single override scenario, then the declared two-scenario config list, and
# proves `down` releases every held descriptor. Reuses the local-platform
# CLI plumbing directly; needs free local-platform ports (never run it next
# to a live run) and `make setup` done.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"

workdir="$(mktemp -d)"
cleanup() {
  python3 ./local-platform/cli.py down >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

for name in seed-check-a seed-check-b; do
  cat >"$workdir/$name.toml" <<EOF
assSchema = 1
name = "$name"

[account]
username = "$name"
password = "password-$name"
namespace = "$name"
pinned = false
EOF
done

# Paths are relative to the config file's directory (D-5).
cat >"$workdir/config.toml" <<EOF
[seed]
scenarios = ["seed-check-a.toml", "seed-check-b.toml"]
EOF

held_count() {
  ./bin/ass status --json | python3 -c \
    'import json, sys; print(len(json.load(sys.stdin).get("held", [])))'
}

assert_held() {
  local expected="$1" label="$2" actual
  actual="$(held_count)"
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: $label — expected $expected held descriptor(s), got $actual" >&2
    exit 1
  fi
  echo "ok: $label ($actual held)"
}

up() {
  python3 ./local-platform/cli.py up --config "$workdir/config.toml"
}

# AC-2: the empty override boots unseeded despite the config file.
LOCAL_PLATFORM_SCENARIOS="" up
assert_held 0 "empty LOCAL_PLATFORM_SCENARIOS boots unseeded"

# AC-2: a single-path override seeds exactly that scenario.
LOCAL_PLATFORM_SCENARIOS="$workdir/seed-check-a.toml" up
assert_held 1 "single-path override seeds exactly one scenario"

# AC-1: re-running up seeds the declared list in order; both worlds held.
up
assert_held 2 "declared scenario list is seeded on up"

# AC-1: down leaves zero held descriptors.
python3 ./local-platform/cli.py down
assert_held 0 "down releases all held descriptors"

trap 'rm -rf "$workdir"' EXIT
echo "seed e2e check passed"
