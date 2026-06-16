#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"
load_resolved_env

mkdir -p "$RUN_DIR/logs" "$RUN_DIR/diagnostics"

services=(
  backend
  edge
  postgres
  redis
  mysql_app_db_1
  mysql_app_db_2
  minio_persistent
  clickhouse
  loki
  vector
)

compose ps > "$RUN_DIR/logs/compose.ps.txt" 2>&1 || true
compose ps --format json > "$RUN_DIR/diagnostics/docker-compose-ps.json" 2>&1 || true
compose config > "$RUN_DIR/diagnostics/docker-compose-config.yaml" 2>&1 || true
compose top > "$RUN_DIR/diagnostics/docker-compose-top.txt" 2>&1 || true
df -h > "$RUN_DIR/diagnostics/disk-usage.txt" 2>&1 || true
du -h -d 3 "$RUN_DIR" > "$RUN_DIR/diagnostics/run-dir-sizes.txt" 2>&1 || true
if [ -d "$LOCAL_PLATFORM_DIR/package-cache" ]; then
  du -h -d 2 "$LOCAL_PLATFORM_DIR/package-cache" > "$RUN_DIR/diagnostics/package-cache-sizes.txt" 2>&1 || true
fi
container_ids="$(compose ps -q 2>/dev/null || true)"
if [ -n "$container_ids" ]; then
  # shellcheck disable=SC2086
  docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}' \
    $container_ids > "$RUN_DIR/diagnostics/docker-stats.txt" 2>&1 || true
fi

for service in "${services[@]}"; do
  compose logs --no-color --timestamps "$service" > "$RUN_DIR/logs/$service.log" 2>&1 || true
done

log "Collected logs and diagnostics in $RUN_DIR"
