"""Fetch the resolved Backend image and Edge binary into the run directory."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import urllib.request
from collections.abc import Callable
from pathlib import Path

from .lib import (
    Ctx,
    DownloadProgress,
    fail,
    log,
    log_warn,
    remove_path_if_exists,
    require_cmd,
    run,
    run_in_pty,
    run_quietly,
)

# Force plain, non-interactive output from gh/docker/aws in this phase, like
# the previous implementation did. Applied per-subprocess so our own log
# coloring is unaffected.
_PLAIN_OUTPUT_ENV = {
    "GLAMOUR_STYLE": "notty",
    "NO_COLOR": "1",
    "CLICOLOR": "0",
    "TERM": "dumb",
    "GH_FORCE_TTY": "0",
}

_GH_ERROR_PATTERN = re.compile(
    r"(no assets to download|not found|HTTP 404|HTTP 403|forbidden"
    r"|failed to get release|could not resolve host|error)"
)


def _fetch_env(ctx: Ctx) -> dict[str, str]:
    return {**ctx.env, **_PLAIN_OUTPUT_ENV}


# ECR account -> AWS profile, mirroring wasmer/backend's Makefile
# (`ACCOUNT_<env>` + `AWS_PROFILE := tf-<env>`, both set from the tf-aws root).
# An ECR hostname carries the owning account, so the right profile follows from
# the image ref itself rather than per-machine configuration.
ECR_ACCOUNT_PROFILES = {
    "376772435488": "tf-dev",
    "864723396604": "tf-bugt",
    "658661676544": "tf-prod",
}

_ECR_REGISTRY_PATTERN = re.compile(
    r"^(\d{12})\.dkr\.ecr\.([^.]+)\.amazonaws\.com$"
)


def parse_ecr_registry(registry: str) -> tuple[str, str] | None:
    """(owning account, region) for an ECR registry host, else None."""
    match = _ECR_REGISTRY_PATTERN.match(registry)
    return (match.group(1), match.group(2)) if match else None


def select_ecr_profile(
    registry_account: str,
    configured: str | None,
    account_of: Callable[[str | None], str | None],
) -> tuple[str | None, str | None]:
    """Pick the AWS profile that actually authenticates to the account owning
    the registry. `None` means ambient credentials (CI's assumed role).

    A profile for the wrong account still logs in successfully — it mints a
    valid token for *its* account — and only fails much later at `docker pull`
    with an opaque 403. So the account is verified up front instead.

    Returns (profile, warning).
    """
    derived = ECR_ACCOUNT_PROFILES.get(registry_account)
    candidates: list[str | None] = []
    for candidate in (configured, derived, None):
        if candidate not in candidates:
            candidates.append(candidate)

    for candidate in candidates:
        if account_of(candidate) != registry_account:
            continue
        if configured is not None and candidate != configured:
            return candidate, (
                f"configured AWS profile {configured} authenticates to a "
                f"different account than ECR registry account "
                f"{registry_account}; using "
                + (f"profile {candidate}" if candidate else "ambient credentials")
                + " instead (set BACKEND_ECR_AWS_PROFILE to silence this)"
            )
        return candidate, None

    fallback = configured or derived
    return fallback, (
        f"no AWS profile authenticates to ECR registry account "
        f"{registry_account} (tried: "
        + ", ".join(c or "<ambient credentials>" for c in candidates)
        + f"); proceeding with "
        + (f"profile {fallback}" if fallback else "ambient credentials")
        + " — a pull may fail with 'not authorized to perform: ecr:BatchGetImage'"
    )


def edge_cache_path(ctx: Ctx) -> Path:
    key = hashlib.sha256(ctx.get("EDGE_RESOLVED").encode()).hexdigest()
    return ctx.edge_cache_dir() / key


def backend_archive_cache_path(ctx: Ctx, source: str) -> Path:
    key = hashlib.sha256(source.encode()).hexdigest()
    return ctx.backend_archive_cache_dir() / key


def is_immutable_artifact_source(resolved: str) -> bool:
    """True only for selectors whose content can never change under the same
    string: a run-id-pinned CI artifact or a concrete-tag release asset.
    path:/url:/latest selectors may float and must never be cached."""
    if resolved.startswith("artifact:"):
        return True
    if resolved.startswith("github-release:"):
        repo, _, rest = resolved.removeprefix("github-release:").partition(":")
        tag, _, pattern = rest.partition(":")
        return bool(repo and pattern) and tag != "latest"
    return False


def _link_or_copy(source: Path, destination: Path) -> None:
    """Hardlink when possible (cache and run dirs share .local-platform, and
    the archive is only ever read); fall back to a copy."""
    remove_path_if_exists(destination)
    try:
        os.link(source, destination)
    except OSError:
        shutil.copyfile(source, destination)


def materialize_backend_archive(ctx: Ctx, source: str, archive: Path) -> None:
    """Fetch the backend image archive through a content-addressed cache for
    immutable sources, mirroring the Edge binary cache: a pinned repro or
    bisection run must not re-download an unchanged ~1GB tar every boot.
    No eviction; entries accumulate per pinned version under
    cache/backend-archives — prune manually if disk matters."""
    if not is_immutable_artifact_source(source):
        log(f"Fetching Backend image archive from {source}")
        fetch_to_file(ctx, source, archive, "backend-image")
        return
    cache_path = backend_archive_cache_path(ctx, source)
    if cache_path.is_file():
        log(f"Using cached Backend image archive: {cache_path}")
        _link_or_copy(cache_path, archive)
        return
    log(f"Fetching Backend image archive from {source}")
    fetch_to_file(ctx, source, archive, "backend-image")
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    # Populate atomically so a parallel/interrupted run never sees a
    # half-written archive as a cache hit.
    cache_tmp = cache_path.with_name(cache_path.name + ".tmp")
    _link_or_copy(archive, cache_tmp)
    os.replace(cache_tmp, cache_path)
    log(f"Cached Backend image archive: {cache_path}")


def _aws_account(ctx: Ctx, profile: str | None) -> str | None:
    """Read-only probe: which AWS account does `profile` authenticate to?
    None when unknown (profile absent, SSO expired, offline)."""
    env = {**_fetch_env(ctx)}
    if profile:
        env["AWS_PROFILE"] = profile
    else:
        env.pop("AWS_PROFILE", None)
    try:
        result = subprocess.run(
            ["aws", "sts", "get-caller-identity", "--query", "Account", "--output", "text"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.decode(errors="replace").strip() or None


def maybe_login_backend_registry(ctx: Ctx, image_ref: str) -> None:
    """Best-effort docker login for ghcr.io / ECR image references."""
    registry = image_ref.split("/", 1)[0]

    if registry == "ghcr.io":
        token = ctx.get("GH_TOKEN") or ctx.get("GITHUB_TOKEN")
        if not token:
            return
        log("Authenticating Docker to ghcr.io using GitHub token")
        run(
            [
                "docker",
                "login",
                "ghcr.io",
                "--username",
                ctx.get("GITHUB_ACTOR") or "github-actions",
                "--password-stdin",
            ],
            env=_fetch_env(ctx),
            input_bytes=token.encode(),
            stdout=subprocess.DEVNULL,
        )
        return

    parsed = parse_ecr_registry(registry)
    if parsed is None:
        return
    if not shutil.which("aws"):
        return
    registry_account, registry_region = parsed

    region = registry_region or ctx.get("BACKEND_PROD_AWS_REGION") or "us-east-1"
    configured = (
        ctx.get("BACKEND_ECR_AWS_PROFILE") or ctx.get("BACKEND_PROD_AWS_PROFILE") or None
    )
    profile, warning = select_ecr_profile(
        registry_account, configured, lambda candidate: _aws_account(ctx, candidate)
    )
    if warning:
        log_warn(warning)
    log(
        f"Authenticating Docker to ECR registry {registry} "
        + (f"using AWS profile {profile}" if profile else "using ambient credentials")
    )

    aws_env = {**_fetch_env(ctx)}
    if profile:
        aws_env["AWS_PROFILE"] = profile
    else:
        aws_env.pop("AWS_PROFILE", None)

    def ecr_docker_login() -> bool:
        password = subprocess.run(
            ["aws", "ecr", "get-login-password", "--region", region],
            env=aws_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if password.returncode != 0:
            return False
        login = subprocess.run(
            ["docker", "login", "--username", "AWS", "--password-stdin", registry],
            env=aws_env,
            input=password.stdout,
            stdout=subprocess.DEVNULL,
        )
        return login.returncode == 0

    if ecr_docker_login():
        return
    if ctx.is_ci():
        fail(f"Failed to authenticate Docker to ECR registry {registry}")
    if not profile:
        fail(
            f"Failed to authenticate Docker to ECR registry {registry} with "
            "ambient credentials and no AWS profile authenticates to account "
            f"{registry_account}"
        )
    log(f"AWS profile {profile} may need SSO login; attempting aws sso login")
    run(["aws", "sso", "login"], env=aws_env)  # interactive; inherits stdio
    if not ecr_docker_login():
        fail(f"Failed to authenticate Docker to ECR registry {registry}")


def _download_url(url: str, destination: Path, label: str) -> None:
    log(f"Downloading {label} from {url}")
    remove_path_if_exists(destination)
    with DownloadProgress(label, destination):
        try:
            with urllib.request.urlopen(url, timeout=60) as response, open(
                destination, "wb"
            ) as out:
                shutil.copyfileobj(response, out)
        except Exception as error:
            fail(f"Failed to download {label} from {url}: {error}")


def _gh_download_into(
    ctx: Ctx,
    gh_args: list[str],
    tmp_dir: Path,
    destination: Path,
    label: str,
    resolved: str,
    progress_path: Path,
) -> None:
    """Run a gh download under a PTY, validate it, and move the single
    downloaded file to `destination`."""
    require_cmd("gh")
    gh_log_file = ctx.require_run_dir() / "logs" / f"{label}-gh-download.log"
    remove_path_if_exists(tmp_dir)
    tmp_dir.mkdir(parents=True)

    remove_path_if_exists(progress_path)
    with DownloadProgress(label, progress_path):
        status = run_in_pty(["gh", *gh_args], gh_log_file, env=_fetch_env(ctx))

    log_text = gh_log_file.read_text(errors="replace") if gh_log_file.exists() else ""
    summary = " ".join(log_text.splitlines()[-20:])
    summary = re.sub(r"\s+", " ", summary).strip()
    if status != 0:
        fail(
            f"GitHub download failed for {label} ({resolved}) with status "
            f"{status}: {summary or 'no gh output captured'}"
        )
    if not log_text.strip():
        fail(f"GitHub download for {label} ({resolved}) produced no log output")
    if _GH_ERROR_PATTERN.search(log_text):
        fail(f"GitHub download failed for {label} ({resolved}): {summary}")

    candidates = sorted(
        entry for entry in tmp_dir.rglob("*") if entry.is_file()
    )
    if not candidates:
        fail(f"{resolved} did not contain any files")
    shutil.copyfile(candidates[0], destination)
    shutil.rmtree(tmp_dir)


def fetch_to_file(ctx: Ctx, resolved: str, destination: Path, label: str) -> bool:
    """Materialize a resolved artifact selector into `destination`.

    Selector forms: path:, url:, artifact:<repo>:<run-id>:<name>,
    github-artifact:<repo>:<name>, github-release:<repo>:<tag>:<pattern>,
    none: (returns False).
    """
    run_dir = ctx.require_run_dir()

    if resolved.startswith("path:"):
        source_path = Path(resolved.removeprefix("path:"))
        if not source_path.exists():
            fail(f"{label} path does not exist: {source_path}")
        shutil.copyfile(source_path, destination)
        return True

    if resolved.startswith("url:"):
        _download_url(resolved.removeprefix("url:"), destination, label)
        return True

    if resolved.startswith("artifact:"):
        repo, _, rest = resolved.removeprefix("artifact:").partition(":")
        run_id, _, artifact_name = rest.partition(":")
        if not (repo and run_id and artifact_name):
            fail(f"Invalid artifact selector for {label}: {resolved}")
        tmp_dir = run_dir / "artifacts" / f".{label}-download"
        log(f"Downloading GitHub Actions artifact {artifact_name} from {repo} run {run_id}")
        _gh_download_into(
            ctx,
            [
                "run",
                "download",
                run_id,
                "--repo",
                repo,
                "--name",
                artifact_name,
                "--dir",
                str(tmp_dir),
            ],
            tmp_dir,
            destination,
            label,
            resolved,
            progress_path=tmp_dir / f"{artifact_name}.zip",
        )
        return True

    if resolved.startswith("github-artifact:"):
        repo, _, artifact_name = resolved.removeprefix("github-artifact:").partition(
            ":"
        )
        if not (repo and artifact_name):
            fail(f"Invalid GitHub artifact selector for {label}: {resolved}")
        tmp_dir = run_dir / "artifacts" / f".{label}-download"
        log(f"Downloading latest GitHub Actions artifact {artifact_name} from {repo}")
        _gh_download_into(
            ctx,
            [
                "run",
                "download",
                "--repo",
                repo,
                "--name",
                artifact_name,
                "--dir",
                str(tmp_dir),
            ],
            tmp_dir,
            destination,
            label,
            resolved,
            progress_path=tmp_dir / f"{artifact_name}.zip",
        )
        return True

    if resolved.startswith("github-release:"):
        repo, _, rest = resolved.removeprefix("github-release:").partition(":")
        tag, _, pattern = rest.partition(":")
        if not (repo and tag and pattern):
            fail(f"Invalid GitHub release selector for {label}: {resolved}")
        tmp_dir = run_dir / "artifacts" / f".{label}-release-download"
        gh_args = ["release", "download"]
        if tag == "latest":
            log(f"Downloading latest GitHub release asset matching '{pattern}' from {repo}")
        else:
            log(f"Downloading GitHub release {tag} asset matching '{pattern}' from {repo}")
            gh_args.append(tag)
        gh_args += ["--repo", repo, "--pattern", pattern, "--dir", str(tmp_dir)]
        _gh_download_into(
            ctx,
            gh_args,
            tmp_dir,
            destination,
            label,
            resolved,
            progress_path=tmp_dir,
        )
        return True

    if resolved.startswith("none:"):
        return False

    fail(f"Unsupported {label} resolver output: {resolved}")


def load_backend_image_archive(ctx: Ctx, archive_path: Path, image_ref: str) -> None:
    load_log = ctx.require_run_dir() / "logs" / "backend-image-load.log"
    load_log.parent.mkdir(parents=True, exist_ok=True)
    log(f"Loading Backend Docker image archive {archive_path} as {image_ref}")
    result = run(
        ["docker", "load", "--input", str(archive_path)],
        env=_fetch_env(ctx),
        capture=True,
    )
    output = result.stdout.decode(errors="replace")
    load_log.write_text(output)
    loaded_refs = re.findall(r"^Loaded image(?: ID)?: (.+)$", output, re.MULTILINE)
    if not loaded_refs:
        fail(
            f"Docker image archive did not report a loaded image; see {load_log}"
        )
    run(["docker", "tag", loaded_refs[-1].strip(), image_ref], env=_fetch_env(ctx))


def preflight_backend_registry(ctx: Ctx) -> None:
    """Registry login for a registry-pull backend, done BEFORE the parallel
    fetch phase: an expired SSO session prompts interactively, which must not
    race concurrent download output. Best-effort, like the old `|| true`."""
    if ctx.get("BACKEND_IMAGE_SOURCE"):
        return
    try:
        maybe_login_backend_registry(ctx, ctx.get("BACKEND_IMAGE_REF"))
    except Exception as error:
        log_warn(f"Backend registry login failed: {error}")


def fetch_backend_image(ctx: Ctx) -> None:
    """Materialize BACKEND_IMAGE_REF locally: docker-load a fetched archive,
    or pull from the (already logged-in) registry."""
    require_cmd("docker")
    run_dir = ctx.require_run_dir()
    (run_dir / "artifacts").mkdir(parents=True, exist_ok=True)

    backend_image_ref = ctx.get("BACKEND_IMAGE_REF")
    backend_image_source = ctx.get("BACKEND_IMAGE_SOURCE")
    if backend_image_source:
        archive = run_dir / "artifacts" / "backend-image.tar"
        materialize_backend_archive(ctx, backend_image_source, archive)
        load_backend_image_archive(ctx, archive, backend_image_ref)
        return

    log(f"Pulling Backend Docker image {backend_image_ref}")
    status = run_quietly(
        "Backend image pull",
        run_dir / "logs" / "backend-image-pull.log",
        ["docker", "pull", backend_image_ref],
        env=_fetch_env(ctx),
        echo_prefix="[backend-image] ",
    )
    if status != 0:
        fail(f"docker pull {backend_image_ref} failed with status {status}", status)


def fetch_edge_binary(ctx: Ctx) -> None:
    run_dir = ctx.require_run_dir()
    (run_dir / "artifacts").mkdir(parents=True, exist_ok=True)

    edge_resolved = ctx.get("EDGE_RESOLVED")
    log(f"Fetching Edge binary from {edge_resolved}")
    edge_destination = run_dir / "artifacts" / "edge"
    cache_path = edge_cache_path(ctx)
    if cache_path.is_file() and os.access(cache_path, os.X_OK):
        log(f"Using cached Edge binary: {cache_path}")
        shutil.copyfile(cache_path, edge_destination)
    else:
        fetch_to_file(ctx, edge_resolved, edge_destination, "edge")
        ctx.edge_cache_dir().mkdir(parents=True, exist_ok=True)
        # Populate the cache atomically so a parallel/interrupted run never
        # sees a half-written binary as a cache hit.
        cache_tmp = cache_path.with_name(cache_path.name + ".tmp")
        shutil.copyfile(edge_destination, cache_tmp)
        cache_tmp.chmod(0o755)
        os.replace(cache_tmp, cache_path)
    edge_destination.chmod(0o755)
    log(
        f"Edge binary ready: {edge_destination} "
        f"({edge_destination.stat().st_size} bytes)"
    )


def write_relay_manifest(ctx: Ctx) -> None:
    manifest = ctx.require_run_dir() / "artifacts" / "relay-persisted-queries.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text("[]\n")
    log(f"Wrote empty Relay persisted query manifest: {manifest}")
