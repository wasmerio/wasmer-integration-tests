#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

[ -n "${RUN_DIR:-}" ] || fail "RUN_DIR must be set before resolving versions"
mkdir -p "$RUN_DIR/artifacts"
set_default_ports

configure_prod_kube_context() {
  local cluster="${BACKEND_PROD_EKS_CLUSTER:-eks-prod-us-east-1}"
  local region="${BACKEND_PROD_AWS_REGION:-us-east-1}"
  local profile="${BACKEND_PROD_AWS_PROFILE:-tf-prod}"

  if [ -n "${BACKEND_PROD_KUBE_CONTEXT:-}" ]; then
    return 0
  fi

  local current_context
  current_context="$(kubectl config current-context 2>/dev/null || true)"
  if printf '%s' "$current_context" | grep -q "$cluster"; then
    log "kubectl context already points at $cluster: $current_context"
    return 0
  fi

  command -v aws >/dev/null 2>&1 || return 1

  log "Configuring kubectl context for production cluster $cluster using AWS profile $profile"
  if AWS_PROFILE="$profile" aws eks update-kubeconfig --name "$cluster" --region "$region" >/dev/null; then
    return 0
  fi

  if ! is_ci; then
    log "AWS profile $profile may need SSO login; attempting aws sso login"
    AWS_PROFILE="$profile" aws sso login
    AWS_PROFILE="$profile" aws eks update-kubeconfig --name "$cluster" --region "$region" >/dev/null
    return 0
  fi

  return 1
}

kubectl_get_backend_image() {
  local namespace="${BACKEND_PROD_KUBE_NAMESPACE:-backend}"
  local deployment="${BACKEND_PROD_DEPLOYMENT:-stackmachine-core}"
  local container="${BACKEND_PROD_CONTAINER:-stackmachine}"
  local context_args=()

  if [ -n "${BACKEND_PROD_KUBE_CONTEXT:-}" ]; then
    context_args=(--context "$BACKEND_PROD_KUBE_CONTEXT")
  fi

  local image
  image="$(kubectl "${context_args[@]}" \
    -n "$namespace" \
    get deployment "$deployment" \
    -o "jsonpath={.spec.template.spec.containers[?(@.name==\"$container\")].image}" 2>/dev/null || true)"

  if [ -z "$image" ]; then
    image="$(kubectl "${context_args[@]}" \
      -n "$namespace" \
      get deployment "$deployment" \
      -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
  fi

  printf '%s' "$image"
}

resolve_backend_dev_github_release() {
  local repo="${BACKEND_DEV_GITHUB_REPO:-wasmerio/backend}"
  local pattern="${BACKEND_DEV_GITHUB_ASSET_PATTERN:-*image*.tar}"
  local tag="${BACKEND_DEV_GITHUB_TAG:-}"
  local suffix="${BACKEND_DEV_RELEASE_SUFFIX:-_dev}"

  if [ -n "$tag" ]; then
    log "Using explicit Backend dev release tag from BACKEND_DEV_GITHUB_TAG: $tag"
    printf 'github-release:%s:%s:%s' "$repo" "$tag" "$pattern"
    return
  fi

  log "Resolving latest Backend dev release from $repo (tag suffix: $suffix, asset pattern: $pattern)"

  if command -v gh >/dev/null 2>&1; then
    local release_json release_error
    release_error="$RUN_DIR/logs/backend-release-list.err"
    if release_json="$(gh release list --repo "$repo" --limit 200 --order desc --json tagName,publishedAt 2>"$release_error")"; then
      tag="$(printf '%s' "$release_json" | node -e '
const suffix = process.argv[1];
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const releases = JSON.parse(input || "[]");
  const matches = releases
    .filter(release => typeof release.tagName === "string" && release.tagName.endsWith(suffix))
    .sort((a, b) => Date.parse(a.publishedAt || "") - Date.parse(b.publishedAt || ""));
  process.stdout.write(matches.at(-1)?.tagName || "");
});
' "$suffix")"
    else
      local error_summary
      error_summary="$(head -n 5 "$release_error" 2>/dev/null | tr '\n' ' ' || true)"
      log_warn "Failed to list Backend releases from $repo: ${error_summary:-unknown gh error}"
    fi
  else
    log_warn "GitHub CLI is not installed; cannot resolve latest Backend dev release automatically"
  fi

  [ -n "$tag" ] || fail "BACKEND_VERSION=resolve_dev could not find a $repo release ending in $suffix that carries an image asset matching '$pattern'. Ensure backend deploys upload the image archive to the release (see tf-aws-project deploy.yaml) and that LOCAL_PLATFORM_ARTIFACT_FETCH_PAT has Contents: Read on $repo, or set BACKEND_DEV_GITHUB_TAG explicitly."
  log "Resolved Backend dev release tag: $tag"
  printf 'github-release:%s:%s:%s' "$repo" "$tag" "$pattern"
}

resolve_backend() {
  local selector="$1"
  case "$selector" in
    resolve_prod)
      if [ -n "${BACKEND_IMAGE_REF:-}" ]; then
        printf '%s' "$BACKEND_IMAGE_REF"
        return
      fi
      if is_ci; then
        local repo="${BACKEND_PROD_GITHUB_REPO:-wasmerio/backend}"
        local image_repository="${BACKEND_IMAGE_REPOSITORY:-ghcr.io/wasmerio/backend}"
        local tag="${BACKEND_PROD_GITHUB_TAG:-}"
        if [ -z "$tag" ] && command -v gh >/dev/null 2>&1; then
          tag="$(gh release view --repo "$repo" --json tagName --jq .tagName 2>/dev/null || true)"
        fi
        [ -n "$tag" ] || fail "BACKEND_VERSION=resolve_prod in CI requires BACKEND_IMAGE_REF, BACKEND_PROD_GITHUB_TAG, or GitHub release access to ${BACKEND_PROD_GITHUB_REPO:-wasmerio/backend}"
        if command -v docker >/dev/null 2>&1 && ! docker manifest inspect "$image_repository:${tag#v}" >/dev/null 2>&1; then
          local pattern="${BACKEND_PROD_GITHUB_ASSET_PATTERN:-*image*.tar}"
          log "Backend prod image tag ${tag#v} not found in $image_repository; falling back to release asset selector from $repo"
          printf 'github-release:%s:%s:%s' "$repo" "$tag" "$pattern"
          return
        fi
        tag="${tag#v}"
        printf '%s:%s' "$image_repository" "$tag"
        return
      fi
      if command -v kubectl >/dev/null 2>&1; then
        configure_prod_kube_context || true
        local image
        image="$(kubectl_get_backend_image)"
        if [ -n "$image" ]; then
          printf '%s' "$image"
          return
        fi
      fi
      fail "BACKEND_VERSION=resolve_prod requires BACKEND_IMAGE_REF or kubectl access to deployment/${BACKEND_PROD_DEPLOYMENT:-stackmachine-core} in namespace ${BACKEND_PROD_KUBE_NAMESPACE:-backend}. Tried to configure prod context via AWS profile ${BACKEND_PROD_AWS_PROFILE:-tf-prod}, cluster ${BACKEND_PROD_EKS_CLUSTER:-eks-prod-us-east-1}."
      ;;
    artifact:*|github-artifact:*|github-release:*|path:*|url:*)
      printf 'local-platform-backend:%s' "$COMPOSE_PROJECT_NAME"
      ;;
    */*:*|*:*)
      printf '%s' "$selector"
      ;;
    v*)
      [ -n "${BACKEND_IMAGE_REPOSITORY:-}" ] || fail "BACKEND_VERSION=$selector requires BACKEND_IMAGE_REPOSITORY for released tags"
      printf '%s:%s' "$BACKEND_IMAGE_REPOSITORY" "$selector"
      ;;
    *)
      fail "Unsupported BACKEND_VERSION selector: $selector"
      ;;
  esac
}

resolve_edge_github_release() {
  local repo="${EDGE_PROD_GITHUB_REPO:-wasmerio/edge}"
  local pattern="${EDGE_PROD_GITHUB_ASSET_PATTERN:-edge}"
  local tag="${EDGE_PROD_GITHUB_TAG:-}"

  if [ -z "$tag" ] && command -v gh >/dev/null 2>&1; then
    tag="$(gh release list --repo "$repo" --limit 100 --json tagName,publishedAt --jq 'sort_by(.publishedAt) | last | .tagName' 2>/dev/null || true)"
  fi

  if [ -z "$tag" ]; then
    tag="latest"
  fi

  printf 'github-release:%s:%s:%s' "$repo" "$tag" "$pattern"
}

resolve_edge_dev_github_release() {
  local repo="${EDGE_DEV_GITHUB_REPO:-wasmerio/edge}"
  local pattern="${EDGE_DEV_GITHUB_ASSET_PATTERN:-edge}"
  local tag="${EDGE_DEV_GITHUB_TAG:-}"
  local suffix="${EDGE_DEV_RELEASE_SUFFIX:-_dev1}"

  if [ -n "$tag" ]; then
    log "Using explicit Edge dev release tag from EDGE_DEV_GITHUB_TAG: $tag"
    printf 'github-release:%s:%s:%s' "$repo" "$tag" "$pattern"
    return
  fi

  log "Resolving latest Edge dev release from $repo (tag suffix: $suffix, asset pattern: $pattern)"

  if command -v gh >/dev/null 2>&1; then
    local release_json release_error
    release_error="$RUN_DIR/logs/edge-release-list.err"
    if release_json="$(gh release list --repo "$repo" --limit 200 --order desc --json tagName,publishedAt 2>"$release_error")"; then
      local recent_tags
      recent_tags="$(printf '%s' "$release_json" | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const releases = JSON.parse(input || "[]");
  const tags = releases.slice(0, 8).map(release => release.tagName).filter(Boolean);
  process.stdout.write(tags.join(", "));
});
')"
      if [ -n "$recent_tags" ]; then
        log "Recent Edge releases: $recent_tags"
      else
        log_warn "GitHub returned no Edge releases for $repo"
      fi

      tag="$(printf '%s' "$release_json" | node -e '
const suffix = process.argv[1];
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const releases = JSON.parse(input || "[]");
  const matches = releases
    .filter(release => typeof release.tagName === "string" && release.tagName.endsWith(suffix))
    .sort((a, b) => Date.parse(a.publishedAt || "") - Date.parse(b.publishedAt || ""));
  process.stdout.write(matches.at(-1)?.tagName || "");
});
' "$suffix")"
    else
      local error_summary
      error_summary="$(head -n 5 "$release_error" 2>/dev/null | tr '\n' ' ' || true)"
      log_warn "Failed to list Edge releases from $repo: ${error_summary:-unknown gh error}"
    fi
  else
    log_warn "GitHub CLI is not installed; cannot resolve latest Edge dev release automatically"
  fi

  [ -n "$tag" ] || fail "EDGE_VERSION=resolve_dev could not find a $repo release ending in $suffix. If recent releases are only bugt/prod, wait for a dev release or set EDGE_DEV_GITHUB_TAG explicitly. Ensure LOCAL_PLATFORM_ARTIFACT_FETCH_PAT has Contents: Read on $repo."
  log "Resolved Edge dev release tag: $tag"
  printf 'github-release:%s:%s:%s' "$repo" "$tag" "$pattern"
}

resolve_edge() {
  local selector="$1"
  case "$selector" in
    resolve_prod)
      if [ -n "${EDGE_PROD_BINARY_PATH:-}" ]; then
        printf 'path:%s' "$EDGE_PROD_BINARY_PATH"
        return
      fi
      if [ -n "${EDGE_PROD_BINARY_URL:-}" ]; then
        printf 'url:%s' "$EDGE_PROD_BINARY_URL"
        return
      fi
      resolve_edge_github_release
      ;;
    resolve_dev|latest_dev|latest-dev)
      if [ -n "${EDGE_DEV_BINARY_PATH:-}" ]; then
        printf 'path:%s' "$EDGE_DEV_BINARY_PATH"
        return
      fi
      if [ -n "${EDGE_DEV_BINARY_URL:-}" ]; then
        printf 'url:%s' "$EDGE_DEV_BINARY_URL"
        return
      fi
      resolve_edge_dev_github_release
      ;;
    artifact:*|github-artifact:*|path:*|url:*|github-release:*)
      printf '%s' "$selector"
      ;;
    v*)
      if [ -n "${EDGE_RELEASE_BASE_URL:-}" ]; then
        printf 'url:%s/%s/edge-linux-x86_64' "${EDGE_RELEASE_BASE_URL%/}" "$selector"
      else
        printf 'github-release:%s:%s:%s' "${EDGE_GITHUB_REPO:-wasmerio/edge}" "$selector" "${EDGE_GITHUB_ASSET_PATTERN:-edge}"
      fi
      ;;
    *)
      fail "Unsupported EDGE_VERSION selector: $selector"
      ;;
  esac
}

# Pre-resolve "latest dev" backend selectors into a concrete github-release
# selector so the rest of the pipeline treats them like any other downloadable
# image archive (docker load + retag) rather than a registry pull.
BACKEND_SELECTOR="$BACKEND_VERSION"
case "$BACKEND_VERSION" in
  resolve_dev|latest_dev|latest-dev)
    BACKEND_SELECTOR="$(resolve_backend_dev_github_release)"
    ;;
esac

BACKEND_IMAGE_REF="$(resolve_backend "$BACKEND_SELECTOR")"
BACKEND_IMAGE_SOURCE=""
case "$BACKEND_SELECTOR" in
  artifact:*|github-artifact:*|github-release:*|path:*|url:*)
    BACKEND_IMAGE_SOURCE="$BACKEND_SELECTOR"
    ;;
esac
EDGE_RESOLVED="$(resolve_edge "$EDGE_VERSION")"
DOCKER_CLI_PATH="${LOCAL_PLATFORM_DOCKER_CLI_PATH:-$(command -v docker)}"
[ -x "$DOCKER_CLI_PATH" ] || fail "Docker CLI is not executable: $DOCKER_CLI_PATH"
DOCKER_BUILDX_PATH="${LOCAL_PLATFORM_DOCKER_BUILDX_PATH:-}"
if [ -z "$DOCKER_BUILDX_PATH" ]; then
  for candidate in \
    /usr/libexec/docker/cli-plugins/docker-buildx \
    /usr/lib/docker/cli-plugins/docker-buildx
  do
    if [ -x "$candidate" ]; then
      DOCKER_BUILDX_PATH="$candidate"
      break
    fi
  done
fi
if [ -z "$DOCKER_BUILDX_PATH" ] && command -v docker-buildx >/dev/null 2>&1; then
  DOCKER_BUILDX_PATH="$(command -v docker-buildx)"
fi
[ -x "$DOCKER_BUILDX_PATH" ] || fail "Docker buildx plugin is not executable: ${DOCKER_BUILDX_PATH:-<not found>}"

{
  write_env_var /dev/stdout BACKEND_VERSION "$BACKEND_VERSION"
  write_env_var /dev/stdout EDGE_VERSION "$EDGE_VERSION"
  write_env_var /dev/stdout BACKEND_IMAGE_REF "$BACKEND_IMAGE_REF"
  write_env_var /dev/stdout BACKEND_IMAGE_SOURCE "$BACKEND_IMAGE_SOURCE"
  write_env_var /dev/stdout EDGE_RESOLVED "$EDGE_RESOLVED"
  write_env_var /dev/stdout LOCAL_TEST_COMMAND "${LOCAL_TEST_COMMAND:-$DEFAULT_TEST_COMMAND}"
  write_env_var /dev/stdout COMPOSE_PROJECT_NAME "$COMPOSE_PROJECT_NAME"
  write_env_var /dev/stdout DOCKER_CLI_PATH "$DOCKER_CLI_PATH"
  write_env_var /dev/stdout DOCKER_BUILDX_PATH "$DOCKER_BUILDX_PATH"
  write_env_var /dev/stdout BACKEND_HTTP_PORT "$BACKEND_HTTP_PORT"
  write_env_var /dev/stdout EDGE_HTTP_PORT "$EDGE_HTTP_PORT"
  write_env_var /dev/stdout EDGE_HTTPS_PORT "$EDGE_HTTPS_PORT"
  write_env_var /dev/stdout EDGE_NODE_API_PORT "$EDGE_NODE_API_PORT"
  write_env_var /dev/stdout EDGE_GRPC_PORT "$EDGE_GRPC_PORT"
  write_env_var /dev/stdout EDGE_SSH_PORT "$EDGE_SSH_PORT"
  write_env_var /dev/stdout EDGE_DNS_PORT "$EDGE_DNS_PORT"
  write_env_var /dev/stdout POSTGRES_PORT "$POSTGRES_PORT"
  write_env_var /dev/stdout REDIS_PORT "$REDIS_PORT"
  write_env_var /dev/stdout MYSQL_APP_DB_1_PORT "$MYSQL_APP_DB_1_PORT"
  write_env_var /dev/stdout MYSQL_APP_DB_2_PORT "$MYSQL_APP_DB_2_PORT"
  write_env_var /dev/stdout MINIO_PERSISTENT_API_PORT "$MINIO_PERSISTENT_API_PORT"
  write_env_var /dev/stdout MINIO_PERSISTENT_CONSOLE_PORT "$MINIO_PERSISTENT_CONSOLE_PORT"
  write_env_var /dev/stdout CLICKHOUSE_HTTP_PORT "$CLICKHOUSE_HTTP_PORT"
  write_env_var /dev/stdout CLICKHOUSE_NATIVE_PORT "$CLICKHOUSE_NATIVE_PORT"
  write_env_var /dev/stdout LOKI_PORT "$LOKI_PORT"
  write_env_var /dev/stdout VECTOR_HTTP_PORT "$VECTOR_HTTP_PORT"
} > "$RUN_DIR/resolved.env"

cat > "$RUN_DIR/resolved.json" <<JSON
{
  "backend_version": $(json_quote "$BACKEND_VERSION"),
  "edge_version": $(json_quote "$EDGE_VERSION"),
  "backend_image_ref": $(json_quote "$BACKEND_IMAGE_REF"),
  "backend_image_source": $(json_quote "$BACKEND_IMAGE_SOURCE"),
  "edge_resolved": $(json_quote "$EDGE_RESOLVED"),
  "compose_project_name": $(json_quote "$COMPOSE_PROJECT_NAME"),
  "docker_cli_path": $(json_quote "$DOCKER_CLI_PATH"),
  "docker_buildx_path": $(json_quote "$DOCKER_BUILDX_PATH"),
  "ports": {
    "backend_http": $(json_quote "$BACKEND_HTTP_PORT"),
    "edge_http": $(json_quote "$EDGE_HTTP_PORT"),
    "edge_https": $(json_quote "$EDGE_HTTPS_PORT"),
    "edge_node_api": $(json_quote "$EDGE_NODE_API_PORT"),
    "edge_grpc": $(json_quote "$EDGE_GRPC_PORT"),
    "edge_ssh": $(json_quote "$EDGE_SSH_PORT"),
    "edge_dns": $(json_quote "$EDGE_DNS_PORT"),
    "postgres": $(json_quote "$POSTGRES_PORT"),
    "redis": $(json_quote "$REDIS_PORT"),
    "mysql_app_db_1": $(json_quote "$MYSQL_APP_DB_1_PORT"),
    "mysql_app_db_2": $(json_quote "$MYSQL_APP_DB_2_PORT"),
    "minio_persistent_api": $(json_quote "$MINIO_PERSISTENT_API_PORT"),
    "minio_persistent_console": $(json_quote "$MINIO_PERSISTENT_CONSOLE_PORT"),
    "clickhouse_http": $(json_quote "$CLICKHOUSE_HTTP_PORT"),
    "clickhouse_native": $(json_quote "$CLICKHOUSE_NATIVE_PORT"),
    "loki": $(json_quote "$LOKI_PORT"),
    "vector_http": $(json_quote "$VECTOR_HTTP_PORT")
  }
}
JSON

if [ -n "$BACKEND_IMAGE_SOURCE" ]; then
  log "Resolved Backend: $BACKEND_IMAGE_SOURCE -> $BACKEND_IMAGE_REF"
else
  log "Resolved Backend: $BACKEND_IMAGE_REF"
fi
log "Resolved Edge: $EDGE_RESOLVED"
