#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"
load_resolved_env

export GLAMOUR_STYLE=notty
export NO_COLOR=1
export CLICOLOR=0
export TERM=dumb
export GH_FORCE_TTY=0

require_cmd docker
mkdir -p "$RUN_DIR/artifacts"

edge_cache_path() {
  local key
  key="$(printf '%s' "$EDGE_RESOLVED" | sha256sum | awk '{print $1}')"
  printf '%s/%s' "$LOCAL_PLATFORM_EDGE_CACHE_DIR" "$key"
}

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
  local progress_pid=""
  local progress_path="$destination"
  local gh_log_file="$RUN_DIR/logs/${label}-gh-download.log"

  start_download_progress() {
    remove_path_if_exists "$progress_path"
    log_download_progress "$label" "$progress_path" "$BASHPID" &
    progress_pid=$!
  }

  stop_download_progress() {
    if [ -n "$progress_pid" ]; then
      kill "$progress_pid" >/dev/null 2>&1 || true
      wait "$progress_pid" >/dev/null 2>&1 || true
      progress_pid=""
    fi
  }

  run_gh_download() {
    local quoted_cmd=()
    local arg
    for arg in "$@"; do
      quoted_cmd+=("$(printf '%q' "$arg")")
    done
    script -q -c "${quoted_cmd[*]}" /dev/null </dev/null >"$gh_log_file" 2>&1
  }

  case "$resolved" in
    path:*)
      local source_path="${resolved#path:}"
      [ -e "$source_path" ] || fail "$label path does not exist: $source_path"
      cp "$source_path" "$destination"
      ;;
    url:*)
      local url="${resolved#url:}"
      require_cmd curl
      log "Downloading $label from $url"
      start_download_progress
      curl --fail --location --silent --show-error "$url" -o "$destination"
      stop_download_progress
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
      progress_path="$tmp_dir/$artifact_name.zip"
      start_download_progress
      run_gh_download gh run download "$run_id" --repo "$repo" --name "$artifact_name" --dir "$tmp_dir"
      stop_download_progress
      local candidate
      candidate="$(find "$tmp_dir" -type f | sort | head -n 1 || true)"
      [ -n "$candidate" ] || fail "Artifact $resolved did not contain any files"
      cp "$candidate" "$destination"
      rm -rf "$tmp_dir"
      ;;
    github-artifact:*)
      require_cmd gh
      local rest="${resolved#github-artifact:}"
      local repo="${rest%%:*}"
      local artifact_name="${rest#*:}"
      [ -n "$repo" ] && [ -n "$artifact_name" ] || fail "Invalid GitHub artifact selector for $label: $resolved"
      local tmp_dir="$RUN_DIR/artifacts/.${label}-download"
      rm -rf "$tmp_dir"
      mkdir -p "$tmp_dir"
      log "Downloading latest GitHub Actions artifact $artifact_name from $repo"
      progress_path="$tmp_dir/$artifact_name.zip"
      start_download_progress
      run_gh_download gh run download --repo "$repo" --name "$artifact_name" --dir "$tmp_dir"
      stop_download_progress
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
      progress_path="$tmp_dir"
      start_download_progress
      if [ "$tag" = "latest" ]; then
        log "Downloading latest GitHub release asset matching '$pattern' from $repo"
        run_gh_download gh release download --repo "$repo" --pattern "$pattern" --dir "$tmp_dir"
      else
        log "Downloading GitHub release $tag asset matching '$pattern' from $repo"
        run_gh_download gh release download "$tag" --repo "$repo" --pattern "$pattern" --dir "$tmp_dir"
      fi
      stop_download_progress
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
  log "Fetching Backend image archive from $BACKEND_IMAGE_SOURCE"
  fetch_to_file "$BACKEND_IMAGE_SOURCE" "$RUN_DIR/artifacts/backend-image.tar" backend-image
  load_backend_image_archive "$RUN_DIR/artifacts/backend-image.tar" "$BACKEND_IMAGE_REF"
else
  log "Pulling Backend Docker image $BACKEND_IMAGE_REF"
  maybe_login_backend_registry "$BACKEND_IMAGE_REF" || true
  docker pull "$BACKEND_IMAGE_REF"
fi

log "Fetching Edge binary from $EDGE_RESOLVED"
EDGE_CACHE_PATH="$(edge_cache_path)"
if [ -x "$EDGE_CACHE_PATH" ]; then
  log "Using cached Edge binary: $EDGE_CACHE_PATH"
  cp "$EDGE_CACHE_PATH" "$RUN_DIR/artifacts/edge"
else
  fetch_to_file "$EDGE_RESOLVED" "$RUN_DIR/artifacts/edge" edge
  mkdir -p "$LOCAL_PLATFORM_EDGE_CACHE_DIR"
  cp "$RUN_DIR/artifacts/edge" "$EDGE_CACHE_PATH"
  chmod +x "$EDGE_CACHE_PATH"
fi
chmod +x "$RUN_DIR/artifacts/edge"
edge_size_bytes="$(wc -c < "$RUN_DIR/artifacts/edge" | tr -d '[:space:]')"
log "Edge binary ready: $RUN_DIR/artifacts/edge (${edge_size_bytes} bytes)"

printf '[]\n' > "$RUN_DIR/artifacts/relay-persisted-queries.json"
log "Wrote empty Relay persisted query manifest: $RUN_DIR/artifacts/relay-persisted-queries.json"
