#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"
load_resolved_env

if ! is_truthy "${LOCAL_PLATFORM_ENSURE_COMPILED:-1}"; then
  log "Skipping package precompilation because LOCAL_PLATFORM_ENSURE_COMPILED=${LOCAL_PLATFORM_ENSURE_COMPILED:-}"
  exit 0
fi

require_cmd docker
require_cmd node

seed_diagnostics="$RUN_DIR/diagnostics/package-seed.json"
extra_list="$REPO_DIR/local-platform/package-compilation-list.txt"
resolved_list="$RUN_DIR/diagnostics/package-compilation-list.resolved.txt"
mkdir -p "$RUN_DIR/logs" "$RUN_DIR/diagnostics"

if is_truthy "${LOCAL_PLATFORM_SEED_PACKAGES:-1}" && [ ! -f "$seed_diagnostics" ]; then
  fail "Package seeding is enabled but $seed_diagnostics is missing; cannot precompile the seeded package set"
fi

node - "$seed_diagnostics" "$extra_list" "$resolved_list" <<'NODE'
const fs = require("node:fs");

const [, , seedDiagnosticsPath, extraListPath, outputPath] = process.argv;
const packages = [];
const seen = new Set();

function add(raw) {
  const value = String(raw || "").trim();
  if (!value || value.startsWith("#")) return;
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  if (!withoutComment || seen.has(withoutComment)) return;
  seen.add(withoutComment);
  packages.push(withoutComment);
}

if (fs.existsSync(seedDiagnosticsPath)) {
  const diagnostics = JSON.parse(fs.readFileSync(seedDiagnosticsPath, "utf8"));
  for (const pkg of diagnostics.resolved || []) {
    if (pkg?.resolvedName && pkg?.resolvedVersion) {
      add(`${pkg.resolvedName}@=${pkg.resolvedVersion}`);
    }
  }
}

if (fs.existsSync(extraListPath)) {
  for (const line of fs.readFileSync(extraListPath, "utf8").split(/\r?\n/)) {
    add(line);
  }
}

fs.writeFileSync(outputPath, `${packages.join("\n")}\n`);
NODE

mapfile -t package_compilation_packages < <(grep -v '^[[:space:]]*$' "$resolved_list" || true)

if [ "${#package_compilation_packages[@]}" -eq 0 ]; then
  log "No packages selected for Edge precompilation"
  exit 0
fi

log "Selected ${#package_compilation_packages[@]} package(s) for Edge precompilation"
log "Package precompilation list: $resolved_list"
while IFS= read -r package; do
  [ -n "$package" ] || continue
  log "  precompile: $package"
done < "$resolved_list"

log "Building Edge runtime helper image for precompilation"
compose build edge >/dev/null

IFS=',' read -r -a package_compilation_engines <<< "${LOCAL_PLATFORM_ENSURE_COMPILED_ENGINES:-wasmer-cranelift}"
ensure_compiled_threads_cli=()
if [ -n "${LOCAL_PLATFORM_ENSURE_COMPILED_THREADS:-}" ] && [ "${LOCAL_PLATFORM_ENSURE_COMPILED_THREADS}" -gt 0 ]; then
  ensure_compiled_threads_cli=(--threads "$LOCAL_PLATFORM_ENSURE_COMPILED_THREADS")
fi

for raw_engine in "${package_compilation_engines[@]}"; do
  engine="$(printf '%s' "$raw_engine" | xargs)"
  [ -n "$engine" ] || continue

  safe_engine="$(printf '%s' "$engine" | tr -c 'A-Za-z0-9_.-' '_')"
  compile_log="$RUN_DIR/logs/ensure-compiled.${safe_engine}.log"
  log "Ensuring Edge compiler cache is warm for engine=$engine (${#package_compilation_packages[@]} package(s))"

  timeout "${LOCAL_PLATFORM_ENSURE_COMPILED_TIMEOUT_SECONDS:-1800}" \
    docker compose --project-name "$COMPOSE_PROJECT_NAME" --file "$COMPOSE_FILE" \
      run --rm --no-deps -T --entrypoint /bin/sh edge \
      -lc 'socat TCP-LISTEN:18000,bind=127.0.0.1,fork,reuseaddr TCP:backend:8000 & exec "$@"' \
      sh /usr/local/bin/edge \
      local ensure-compiled \
      --config-path /config/platform_config.yaml \
      --data-dir /data \
      --scan-filesystem \
      --engine "$engine" \
      "${ensure_compiled_threads_cli[@]}" \
      "${package_compilation_packages[@]}" \
    2>&1 | tee "$compile_log"
done

log "Edge package precompilation complete"
