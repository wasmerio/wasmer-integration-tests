#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"
load_resolved_env

require_cmd docker
mkdir -p "$RUN_DIR/artifacts"

maybe_login_backend_registry() {
  local image_ref="$1"
  local registry="${image_ref%%/*}"

  case "$registry" in
    ghcr.io)
      local token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
      [ -n "$token" ] || return 0
      log "Authenticating Docker to ghcr.io using GitHub token"
      printf '%s' "$token" \
        | docker login ghcr.io --username "${GITHUB_ACTOR:-github-actions}" --password-stdin >/dev/null
      return 0
      ;;
    *.dkr.ecr.*.amazonaws.com)
      ;;
    *)
      return 0
      ;;
  esac

  command -v aws >/dev/null 2>&1 || return 0

  local region
  region="$(printf '%s' "$registry" | sed -n 's/.*\.dkr\.ecr\.\([^.]*\)\.amazonaws\.com/\1/p')"
  [ -n "$region" ] || region="${BACKEND_PROD_AWS_REGION:-us-east-1}"

  local profile="${BACKEND_ECR_AWS_PROFILE:-${BACKEND_PROD_AWS_PROFILE:-tf-prod}}"
  log "Authenticating Docker to ECR registry $registry using AWS profile $profile"

  if ! AWS_PROFILE="$profile" aws ecr get-login-password --region "$region" \
    | docker login --username AWS --password-stdin "$registry" >/dev/null; then
    if ! is_ci; then
      log "AWS profile $profile may need SSO login; attempting aws sso login"
      AWS_PROFILE="$profile" aws sso login
      AWS_PROFILE="$profile" aws ecr get-login-password --region "$region" \
        | docker login --username AWS --password-stdin "$registry" >/dev/null
      return 0
    fi
    return 1
  fi
}

fetch_to_file() {
  local resolved="$1"
  local destination="$2"
  local label="$3"

  case "$resolved" in
    path:*)
      local source_path="${resolved#path:}"
      [ -e "$source_path" ] || fail "$label path does not exist: $source_path"
      cp "$source_path" "$destination"
      ;;
    url:*)
      local url="${resolved#url:}"
      require_cmd curl
      curl -fsSL "$url" -o "$destination"
      ;;
    artifact:*)
      require_cmd gh
      local rest="${resolved#artifact:}"
      local repo="${rest%%:*}"
      rest="${rest#*:}"
      local run_id="${rest%%:*}"
      local artifact_name="${rest#*:}"
      [ -n "$repo" ] && [ -n "$run_id" ] && [ -n "$artifact_name" ] || fail "Invalid artifact selector for $label: $resolved"
      local tmp_dir="$RUN_DIR/artifacts/.${label}-download"
      rm -rf "$tmp_dir"
      mkdir -p "$tmp_dir"
      log "Downloading GitHub Actions artifact $artifact_name from $repo run $run_id"
      gh run download "$run_id" --repo "$repo" --name "$artifact_name" --dir "$tmp_dir"
      local candidate
      candidate="$(find "$tmp_dir" -type f | sort | head -n 1 || true)"
      [ -n "$candidate" ] || fail "Artifact $resolved did not contain any files"
      cp "$candidate" "$destination"
      rm -rf "$tmp_dir"
      ;;
    github-release:*)
      require_cmd gh
      local rest="${resolved#github-release:}"
      local repo="${rest%%:*}"
      rest="${rest#*:}"
      local tag="${rest%%:*}"
      local pattern="${rest#*:}"
      [ -n "$repo" ] && [ -n "$tag" ] && [ -n "$pattern" ] || fail "Invalid GitHub release selector for $label: $resolved"
      local tmp_dir="$RUN_DIR/artifacts/.${label}-release-download"
      rm -rf "$tmp_dir"
      mkdir -p "$tmp_dir"
      if [ "$tag" = "latest" ]; then
        log "Downloading latest GitHub release asset matching '$pattern' from $repo"
        gh release download --repo "$repo" --pattern "$pattern" --dir "$tmp_dir"
      else
        log "Downloading GitHub release $tag asset matching '$pattern' from $repo"
        gh release download "$tag" --repo "$repo" --pattern "$pattern" --dir "$tmp_dir"
      fi
      local candidate
      candidate="$(find "$tmp_dir" -type f | sort | head -n 1 || true)"
      [ -n "$candidate" ] || fail "GitHub release $resolved did not download any files"
      cp "$candidate" "$destination"
      rm -rf "$tmp_dir"
      ;;
    none:*)
      return 1
      ;;
    *)
      fail "Unsupported $label resolver output: $resolved"
      ;;
  esac
}

load_backend_image_archive() {
  local archive_path="$1"
  local image_ref="$2"
  local load_log="$RUN_DIR/logs/backend-image-load.log"

  log "Loading Backend Docker image archive $archive_path as $image_ref"
  local loaded_ref
  loaded_ref="$(docker load --input "$archive_path" | tee "$load_log" \
    | sed -n 's/^Loaded image: //p; s/^Loaded image ID: //p' \
    | tail -n 1)"
  [ -n "$loaded_ref" ] || fail "Docker image archive did not report a loaded image; see $load_log"
  docker tag "$loaded_ref" "$image_ref"
}

if [ -n "${BACKEND_IMAGE_SOURCE:-}" ]; then
  fetch_to_file "$BACKEND_IMAGE_SOURCE" "$RUN_DIR/artifacts/backend-image.tar" backend-image
  load_backend_image_archive "$RUN_DIR/artifacts/backend-image.tar" "$BACKEND_IMAGE_REF"
else
  maybe_login_backend_registry "$BACKEND_IMAGE_REF" || true
  docker pull "$BACKEND_IMAGE_REF"
fi

fetch_to_file "$EDGE_RESOLVED" "$RUN_DIR/artifacts/edge" edge
chmod +x "$RUN_DIR/artifacts/edge"
log "Edge binary ready: $RUN_DIR/artifacts/edge"

if fetch_to_file "$FRONTEND_RESOLVED" "$RUN_DIR/artifacts/relay-persisted-queries.json" frontend-relay; then
  log "Relay persisted queries ready: $RUN_DIR/artifacts/relay-persisted-queries.json"
else
  printf '[]\n' > "$RUN_DIR/artifacts/relay-persisted-queries.json"
  log "No frontend Relay manifest resolved; wrote an empty manifest"
fi
