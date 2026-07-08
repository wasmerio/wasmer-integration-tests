"""Resolve BACKEND_VERSION / EDGE_VERSION selectors into concrete inputs.

Backend selectors resolve to a Docker image reference (registry pull) or a
downloadable image archive selector; Edge selectors resolve to a binary
source (path:/url:/artifact:/github-artifact:/github-release:). The result is
recorded in `<run>/resolved.env` (shell-sourceable) and `<run>/resolved.json`.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from .lib import (
    Ctx,
    DEFAULT_TEST_COMMAND,
    Fail,
    RESOLVED_ENV_KEYS,
    fail,
    log,
    log_warn,
    run,
    try_output,
    write_env_file,
)

ARCHIVE_SELECTOR_PREFIXES = (
    "artifact:",
    "github-artifact:",
    "github-release:",
    "path:",
    "url:",
)


def configure_prod_kube_context(ctx: Ctx) -> bool:
    cluster = ctx.get("BACKEND_PROD_EKS_CLUSTER") or "eks-prod-us-east-1"
    region = ctx.get("BACKEND_PROD_AWS_REGION") or "us-east-1"
    profile = ctx.get("BACKEND_PROD_AWS_PROFILE") or "tf-prod"

    if ctx.get("BACKEND_PROD_KUBE_CONTEXT"):
        return True

    current_context = try_output(
        ["kubectl", "config", "current-context"], env=ctx.env
    )
    if cluster in current_context:
        log(f"kubectl context already points at {cluster}: {current_context}")
        return True

    if not shutil.which("aws"):
        return False

    log(
        f"Configuring kubectl context for production cluster {cluster} "
        f"using AWS profile {profile}"
    )
    aws_env = {**ctx.env, "AWS_PROFILE": profile}
    update_cmd = [
        "aws",
        "eks",
        "update-kubeconfig",
        "--name",
        cluster,
        "--region",
        region,
    ]
    if (
        run(update_cmd, env=aws_env, check=False, stdout=subprocess.DEVNULL).returncode
        == 0
    ):
        return True

    if not ctx.is_ci():
        log(f"AWS profile {profile} may need SSO login; attempting aws sso login")
        run(["aws", "sso", "login"], env=aws_env)  # interactive; inherits stdio
        run(update_cmd, env=aws_env, stdout=subprocess.DEVNULL)
        return True

    return False


def kubectl_get_backend_image(ctx: Ctx) -> str:
    namespace = ctx.get("BACKEND_PROD_KUBE_NAMESPACE") or "backend"
    deployment = ctx.get("BACKEND_PROD_DEPLOYMENT") or "stackmachine-core"
    container = ctx.get("BACKEND_PROD_CONTAINER") or "stackmachine"
    context_args = []
    if ctx.get("BACKEND_PROD_KUBE_CONTEXT"):
        context_args = ["--context", ctx.get("BACKEND_PROD_KUBE_CONTEXT")]

    image = try_output(
        [
            "kubectl",
            *context_args,
            "-n",
            namespace,
            "get",
            "deployment",
            deployment,
            "-o",
            f'jsonpath={{.spec.template.spec.containers[?(@.name=="{container}")].image}}',
        ],
        env=ctx.env,
    )
    if not image:
        image = try_output(
            [
                "kubectl",
                *context_args,
                "-n",
                namespace,
                "get",
                "deployment",
                deployment,
                "-o",
                "jsonpath={.spec.template.spec.containers[0].image}",
            ],
            env=ctx.env,
        )
    return image


def _gh_release_list(
    ctx: Ctx, repo: str, limit: int, error_log: Path | None = None
) -> list[dict] | None:
    """`gh release list --json tagName,publishedAt`, newest first, or None on
    failure (logging a summary of gh's stderr)."""
    result = subprocess.run(
        [
            "gh",
            "release",
            "list",
            "--repo",
            repo,
            "--limit",
            str(limit),
            "--order",
            "desc",
            "--json",
            "tagName,publishedAt",
        ],
        env=dict(ctx.env),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        stderr = result.stderr.decode(errors="replace")
        if error_log is not None:
            error_log.parent.mkdir(parents=True, exist_ok=True)
            error_log.write_text(stderr)
        summary = " ".join(stderr.splitlines()[:5]).strip()
        log_warn(
            f"Failed to list releases from {repo}: {summary or 'unknown gh error'}"
        )
        return None
    try:
        return json.loads(result.stdout or b"[]")
    except json.JSONDecodeError as error:
        log_warn(f"Could not parse gh release list output for {repo}: {error}")
        return None


def _published_at(release: dict) -> datetime:
    raw = str(release.get("publishedAt") or "")
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def _latest_release_tag_with_suffix(releases: list[dict], suffix: str) -> str:
    matches = [
        release
        for release in releases
        if isinstance(release.get("tagName"), str)
        and release["tagName"].endswith(suffix)
    ]
    matches.sort(key=_published_at)
    return matches[-1]["tagName"] if matches else ""


def resolve_backend_dev_github_release(ctx: Ctx) -> str:
    repo = ctx.get("BACKEND_DEV_GITHUB_REPO") or "wasmerio/backend"
    pattern = ctx.get("BACKEND_DEV_GITHUB_ASSET_PATTERN") or "*image*.tar"
    tag = ctx.get("BACKEND_DEV_GITHUB_TAG")
    suffix = ctx.get("BACKEND_DEV_RELEASE_SUFFIX") or "_dev"

    if tag:
        log(f"Using explicit Backend dev release tag from BACKEND_DEV_GITHUB_TAG: {tag}")
        return f"github-release:{repo}:{tag}:{pattern}"

    log(
        f"Resolving latest Backend dev release from {repo} "
        f"(tag suffix: {suffix}, asset pattern: {pattern})"
    )
    if shutil.which("gh"):
        releases = _gh_release_list(
            ctx,
            repo,
            200,
            error_log=ctx.require_run_dir() / "logs" / "backend-release-list.err",
        )
        if releases is not None:
            tag = _latest_release_tag_with_suffix(releases, suffix)
    else:
        log_warn(
            "GitHub CLI is not installed; cannot resolve latest Backend dev "
            "release automatically"
        )

    if not tag:
        fail(
            f"BACKEND_VERSION=resolve_dev could not find a {repo} release ending "
            f"in {suffix} that carries an image asset matching '{pattern}'. Ensure "
            f"backend deploys upload the image archive to the release (see "
            f"tf-aws-project deploy.yaml) and that LOCAL_PLATFORM_ARTIFACT_FETCH_PAT "
            f"has Contents: Read on {repo}, or set BACKEND_DEV_GITHUB_TAG explicitly."
        )
    log(f"Resolved Backend dev release tag: {tag}")
    return f"github-release:{repo}:{tag}:{pattern}"


def resolve_backend(ctx: Ctx, selector: str) -> str:
    if selector == "resolve_prod":
        if ctx.get("BACKEND_IMAGE_REF"):
            return ctx.get("BACKEND_IMAGE_REF")
        if ctx.is_ci():
            repo = ctx.get("BACKEND_PROD_GITHUB_REPO") or "wasmerio/backend"
            image_repository = (
                ctx.get("BACKEND_IMAGE_REPOSITORY") or "ghcr.io/wasmerio/backend"
            )
            tag = ctx.get("BACKEND_PROD_GITHUB_TAG")
            if not tag and shutil.which("gh"):
                tag = try_output(
                    [
                        "gh",
                        "release",
                        "view",
                        "--repo",
                        repo,
                        "--json",
                        "tagName",
                        "--jq",
                        ".tagName",
                    ],
                    env=ctx.env,
                )
            if not tag:
                fail(
                    "BACKEND_VERSION=resolve_prod in CI requires BACKEND_IMAGE_REF, "
                    "BACKEND_PROD_GITHUB_TAG, or GitHub release access to "
                    f"{repo}"
                )
            bare_tag = tag.removeprefix("v")
            if shutil.which("docker") and (
                subprocess.run(
                    ["docker", "manifest", "inspect", f"{image_repository}:{bare_tag}"],
                    env=dict(ctx.env),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                ).returncode
                != 0
            ):
                pattern = ctx.get("BACKEND_PROD_GITHUB_ASSET_PATTERN") or "*image*.tar"
                log(
                    f"Backend prod image tag {bare_tag} not found in "
                    f"{image_repository}; falling back to release asset selector "
                    f"from {repo}"
                )
                return f"github-release:{repo}:{tag}:{pattern}"
            return f"{image_repository}:{bare_tag}"
        if shutil.which("kubectl"):
            # Best-effort (was `configure_prod_kube_context || true`): a
            # failed SSO login or update-kubeconfig must not prevent trying
            # kubectl with whatever context is already configured.
            try:
                configure_prod_kube_context(ctx)
            except Exception as error:
                log_warn(f"Could not configure prod kube context: {error}")
            image = kubectl_get_backend_image(ctx)
            if image:
                return image
        fail(
            "BACKEND_VERSION=resolve_prod requires BACKEND_IMAGE_REF or kubectl "
            "access to deployment/"
            f"{ctx.get('BACKEND_PROD_DEPLOYMENT') or 'stackmachine-core'} in "
            f"namespace {ctx.get('BACKEND_PROD_KUBE_NAMESPACE') or 'backend'}. "
            "Tried to configure prod context via AWS profile "
            f"{ctx.get('BACKEND_PROD_AWS_PROFILE') or 'tf-prod'}, cluster "
            f"{ctx.get('BACKEND_PROD_EKS_CLUSTER') or 'eks-prod-us-east-1'}."
        )
    if selector.startswith(ARCHIVE_SELECTOR_PREFIXES):
        # Downloadable archive: it will be docker-loaded and retagged under a
        # project-local name.
        return f"local-platform-backend:{ctx.get('COMPOSE_PROJECT_NAME')}"
    if ":" in selector:
        return selector  # already an image reference
    if selector.startswith("v"):
        if not ctx.get("BACKEND_IMAGE_REPOSITORY"):
            fail(
                f"BACKEND_VERSION={selector} requires BACKEND_IMAGE_REPOSITORY "
                "for released tags"
            )
        return f"{ctx.get('BACKEND_IMAGE_REPOSITORY')}:{selector}"
    fail(f"Unsupported BACKEND_VERSION selector: {selector}")


def resolve_edge_github_release(ctx: Ctx) -> str:
    repo = ctx.get("EDGE_PROD_GITHUB_REPO") or "wasmerio/edge"
    pattern = ctx.get("EDGE_PROD_GITHUB_ASSET_PATTERN") or "edge"
    tag = ctx.get("EDGE_PROD_GITHUB_TAG")

    if not tag and shutil.which("gh"):
        releases = _gh_release_list(ctx, repo, 100)
        if releases:
            releases.sort(key=_published_at)
            tag = str(releases[-1].get("tagName") or "")
    if not tag:
        tag = "latest"
    return f"github-release:{repo}:{tag}:{pattern}"


def resolve_edge_dev_github_release(ctx: Ctx) -> str:
    repo = ctx.get("EDGE_DEV_GITHUB_REPO") or "wasmerio/edge"
    pattern = ctx.get("EDGE_DEV_GITHUB_ASSET_PATTERN") or "edge"
    tag = ctx.get("EDGE_DEV_GITHUB_TAG")
    suffix = ctx.get("EDGE_DEV_RELEASE_SUFFIX") or "_dev1"

    if tag:
        log(f"Using explicit Edge dev release tag from EDGE_DEV_GITHUB_TAG: {tag}")
        return f"github-release:{repo}:{tag}:{pattern}"

    log(
        f"Resolving latest Edge dev release from {repo} "
        f"(tag suffix: {suffix}, asset pattern: {pattern})"
    )
    if shutil.which("gh"):
        releases = _gh_release_list(
            ctx,
            repo,
            200,
            error_log=ctx.require_run_dir() / "logs" / "edge-release-list.err",
        )
        if releases is not None:
            recent = ", ".join(
                str(release.get("tagName"))
                for release in releases[:8]
                if release.get("tagName")
            )
            if recent:
                log(f"Recent Edge releases: {recent}")
            else:
                log_warn(f"GitHub returned no Edge releases for {repo}")
            tag = _latest_release_tag_with_suffix(releases, suffix)
    else:
        log_warn(
            "GitHub CLI is not installed; cannot resolve latest Edge dev "
            "release automatically"
        )

    if not tag:
        fail(
            f"EDGE_VERSION=resolve_dev could not find a {repo} release ending in "
            f"{suffix}. If recent releases are only bugt/prod, wait for a dev "
            f"release or set EDGE_DEV_GITHUB_TAG explicitly. Ensure "
            f"LOCAL_PLATFORM_ARTIFACT_FETCH_PAT has Contents: Read on {repo}."
        )
    log(f"Resolved Edge dev release tag: {tag}")
    return f"github-release:{repo}:{tag}:{pattern}"


def resolve_edge(ctx: Ctx, selector: str) -> str:
    if selector == "resolve_prod":
        if ctx.get("EDGE_PROD_BINARY_PATH"):
            return f"path:{ctx.get('EDGE_PROD_BINARY_PATH')}"
        if ctx.get("EDGE_PROD_BINARY_URL"):
            return f"url:{ctx.get('EDGE_PROD_BINARY_URL')}"
        return resolve_edge_github_release(ctx)
    if selector in ("resolve_dev", "latest_dev", "latest-dev"):
        if ctx.get("EDGE_DEV_BINARY_PATH"):
            return f"path:{ctx.get('EDGE_DEV_BINARY_PATH')}"
        if ctx.get("EDGE_DEV_BINARY_URL"):
            return f"url:{ctx.get('EDGE_DEV_BINARY_URL')}"
        return resolve_edge_dev_github_release(ctx)
    if selector.startswith(ARCHIVE_SELECTOR_PREFIXES):
        return selector
    if selector.startswith("v"):
        base_url = ctx.get("EDGE_RELEASE_BASE_URL")
        if base_url:
            return f"url:{base_url.rstrip('/')}/{selector}/edge-linux-x86_64"
        repo = ctx.get("EDGE_GITHUB_REPO") or "wasmerio/edge"
        pattern = ctx.get("EDGE_GITHUB_ASSET_PATTERN") or "edge"
        return f"github-release:{repo}:{selector}:{pattern}"
    fail(f"Unsupported EDGE_VERSION selector: {selector}")


def _find_docker_buildx(ctx: Ctx) -> str:
    override = ctx.get("LOCAL_PLATFORM_DOCKER_BUILDX_PATH")
    if override:
        return override
    for candidate in (
        "/usr/libexec/docker/cli-plugins/docker-buildx",
        "/usr/lib/docker/cli-plugins/docker-buildx",
    ):
        if os.access(candidate, os.X_OK):
            return candidate
    return shutil.which("docker-buildx") or ""


def resolve(ctx: Ctx) -> None:
    """Resolve everything and record it in ctx.env + resolved.env/json."""
    run_dir = ctx.require_run_dir()
    (run_dir / "artifacts").mkdir(parents=True, exist_ok=True)
    ctx.set_default_ports()

    backend_version = ctx.get("BACKEND_VERSION")
    edge_version = ctx.get("EDGE_VERSION")

    # Pre-resolve "latest dev" backend selectors into a concrete
    # github-release selector so the rest of the pipeline treats them like any
    # other downloadable image archive (docker load + retag) rather than a
    # registry pull.
    backend_selector = backend_version
    if backend_version in ("resolve_dev", "latest_dev", "latest-dev"):
        backend_selector = resolve_backend_dev_github_release(ctx)
    elif backend_version == "resolve_prod":
        backend_selector = resolve_backend(ctx, backend_version)

    backend_image_ref = resolve_backend(ctx, backend_selector)
    backend_image_source = (
        backend_selector
        if backend_selector.startswith(ARCHIVE_SELECTOR_PREFIXES)
        else ""
    )
    edge_resolved = resolve_edge(ctx, edge_version)

    docker_cli_path = ctx.get("LOCAL_PLATFORM_DOCKER_CLI_PATH") or (
        shutil.which("docker") or ""
    )
    if not docker_cli_path or not os.access(docker_cli_path, os.X_OK):
        fail(f"Docker CLI is not executable: {docker_cli_path or '<not found>'}")
    docker_buildx_path = _find_docker_buildx(ctx)
    if not docker_buildx_path or not os.access(docker_buildx_path, os.X_OK):
        fail(
            "Docker buildx plugin is not executable: "
            f"{docker_buildx_path or '<not found>'}"
        )

    ctx.env.update(
        {
            "BACKEND_IMAGE_REF": backend_image_ref,
            "BACKEND_IMAGE_SOURCE": backend_image_source,
            "EDGE_RESOLVED": edge_resolved,
            "LOCAL_TEST_COMMAND": ctx.get("LOCAL_TEST_COMMAND")
            or DEFAULT_TEST_COMMAND,
            "DOCKER_CLI_PATH": docker_cli_path,
            "DOCKER_BUILDX_PATH": docker_buildx_path,
        }
    )

    write_env_file(
        run_dir / "resolved.env", {key: ctx.get(key) for key in RESOLVED_ENV_KEYS}
    )
    (run_dir / "resolved.json").write_text(
        json.dumps(
            {
                "backend_version": ctx.get("BACKEND_VERSION"),
                "edge_version": ctx.get("EDGE_VERSION"),
                "backend_image_ref": backend_image_ref,
                "backend_image_source": backend_image_source,
                "edge_resolved": edge_resolved,
                "local_test_command": ctx.get("LOCAL_TEST_COMMAND"),
                "compose_project_name": ctx.get("COMPOSE_PROJECT_NAME"),
                "docker_cli_path": docker_cli_path,
                "docker_buildx_path": docker_buildx_path,
                "ports": {
                    name.removesuffix("_PORT").lower(): ctx.get(name)
                    for name in (
                        "BACKEND_HTTP_PORT",
                        "EDGE_HTTP_PORT",
                        "EDGE_HTTPS_PORT",
                        "EDGE_NODE_API_PORT",
                        "EDGE_GRPC_PORT",
                        "EDGE_SSH_PORT",
                        "EDGE_DNS_PORT",
                        "POSTGRES_PORT",
                        "REDIS_PORT",
                        "MYSQL_APP_DB_1_PORT",
                        "MYSQL_APP_DB_2_PORT",
                        "MINIO_PERSISTENT_API_PORT",
                        "MINIO_PERSISTENT_CONSOLE_PORT",
                        "CLICKHOUSE_HTTP_PORT",
                        "CLICKHOUSE_NATIVE_PORT",
                        "LOKI_PORT",
                        "VECTOR_HTTP_PORT",
                    )
                },
            },
            indent=2,
        )
        + "\n"
    )

    if backend_image_source:
        log(f"Resolved Backend: {backend_image_source} -> {backend_image_ref}")
    else:
        log(f"Resolved Backend: {backend_image_ref}")
    log(f"Resolved Edge: {edge_resolved}")
