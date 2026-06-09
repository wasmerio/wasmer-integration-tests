#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"
load_resolved_env

mkdir -p "$RUN_DIR/edge" "$RUN_DIR/artifacts"
touch "$RUN_DIR/backend.env"

log "Generating backend/test env with smbe local-dev-env"
bootstrap_output="$RUN_DIR/logs/bootstrap.log"
bootstrap_raw="$RUN_DIR/.bootstrap.raw.log"
set +e
timeout "${LOCAL_PLATFORM_BOOTSTRAP_TIMEOUT_SECONDS:-300}" \
  docker run --rm \
    --network "${COMPOSE_PROJECT_NAME}_default" \
    --user "$(id -u):$(id -g)" \
    --add-host host.docker.internal:host-gateway \
    -v "$RUN_DIR:/platform" \
    -e AWS_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/wapm \
    -e DATABASE_URL=postgresql://postgres:postgres@postgres:5432/wapm \
    -e REDIS_URL=redis://redis:6379 \
    -e SM_BE_CACHE=redis://redis:6379/0 \
    -e SM_BE_MSGBUS=redis://redis:6379/1 \
    -e 'SM_BE_DATASTORE_PRIVATE_URI=s3://minioadmin:minioadmin@minio-persistent:9000/backend-datastore-private?style=path&region=us-east-1' \
    -e "SM_BE_PUBLIC_URL=http://localhost:${BACKEND_HTTP_PORT}" \
    -e "SM_BE_FRONTEND_URL=http://localhost:${FRONTEND_HTTP_PORT}" \
    -e SM_BE_PRIMARY_APP_DOMAIN=localhost \
    -e LOKI_URI=http://loki:3100 \
    -e METRICS_CLICKHOUSE_URL=http://default:root@clickhouse:8123/edge_metrics_local \
    -e RUST_LOG=info \
    -e SECRET_KEY=local-dev-secret \
    --entrypoint /app/smbe \
    "$BACKEND_IMAGE_REF" \
    local-dev-env \
    --state-dir /platform/state \
    --namespace wasmer-integration-tests \
    --public-url "http://localhost:${BACKEND_HTTP_PORT}" \
    --app-domain localhost \
    --edge-server "http://127.0.0.1:${EDGE_HTTP_PORT}" \
    --edge-ssh-server "ssh://127.0.0.1:${EDGE_SSH_PORT}" \
    --edge-dns-server "127.0.0.1:${EDGE_DNS_PORT}" \
    --mysql-host host.docker.internal \
    --mysql-port "$MYSQL_APP_DB_1_PORT" \
    --mysql-secondary-port "$MYSQL_APP_DB_2_PORT" \
    --mysql-user admin \
    --mysql-password admin \
    --loki-uri http://loki:3100 \
    --metrics-clickhouse-host clickhouse \
    --metrics-clickhouse-port 8123 \
    --write-test-env /platform/test-env.sh \
    --write-backend-env /platform/backend.env \
    --skip-templates > "$bootstrap_raw" 2>&1
bootstrap_status=$?
set -e
sed -E 's/(WASMER_TOKEN=).+$/\1<redacted>/; s/(EDGE_SYNC_TOKEN=).+$/\1<redacted>/' "$bootstrap_raw" > "$bootstrap_output" || true
if [ "$bootstrap_status" -ne 0 ]; then
  cat "$bootstrap_output" >&2 || true
  rm -f "$bootstrap_raw"
  exit "$bootstrap_status"
fi

log "Generating local Edge config from bootstrap outputs"
node "$REPO_DIR/local-platform/scripts/generate-edge-config.mjs" \
  "$RUN_DIR" \
  "$bootstrap_raw" \
  "$RUN_DIR/edge/platform_config.yaml"
rm -f "$bootstrap_raw"

[ -s "$RUN_DIR/backend.env" ] || fail "Bootstrap did not write $RUN_DIR/backend.env"
[ -s "$RUN_DIR/test-env.sh" ] || fail "Bootstrap did not write $RUN_DIR/test-env.sh"
[ -s "$RUN_DIR/edge/platform_config.yaml" ] || fail "Bootstrap did not write $RUN_DIR/edge/platform_config.yaml"

# Ensure the generated test env contains the isolated integration-test ports.
{
  printf '\n# local-platform isolated test endpoints\n'
  printf 'export WASMER_REGISTRY="http://localhost:%s/graphql"\n' "$BACKEND_HTTP_PORT"
  printf 'export WASMER_APP_DOMAIN="localhost"\n'
  printf 'export EDGE_SERVER="http://127.0.0.1:%s"\n' "$EDGE_HTTP_PORT"
  printf 'export EDGE_SSH_SERVER="ssh://127.0.0.1:%s"\n' "$EDGE_SSH_PORT"
  printf 'export EDGE_DNS_SERVER="127.0.0.1:%s"\n' "$EDGE_DNS_PORT"
  printf 'export LOCAL_PLATFORM_RELAX_EDGE_VERSION_HEADER="1"\n'
} >> "$RUN_DIR/test-env.sh"

log "Bootstrap complete"
