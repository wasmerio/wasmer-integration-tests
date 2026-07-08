"""Bootstrap the disposable backend: generate backend.env / test-env.sh via
`smbe local-dev-env`, produce the Edge platform config, and mint the Edge
gRPC token."""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from .lib import (
    Ctx,
    fail,
    is_truthy,
    log,
    log_warn,
    require_cmd,
    run,
    run_quietly,
    try_output,
)


def _detect_mysql_app_host(ctx: Ctx) -> str:
    host = ctx.get("LOCAL_PLATFORM_MYSQL_APP_HOST")
    if host:
        return host
    host = try_output(
        [
            "docker",
            "network",
            "inspect",
            "bridge",
            "--format",
            "{{(index .IPAM.Config 0).Gateway}}",
        ],
        env=ctx.env,
    )
    return host or "172.17.0.1"


def _smbe_dev_env_subcommand(ctx: Ctx, image_ref: str) -> list[str]:
    """The local-dev-env subcommand moved under a `develop` parent in backend
    bc1a7ad9 ("Reorganize & document CLI commands", 2026-06-22). Older
    pinned/production images expose it at the top level (`smbe local-dev-env`);
    newer images nest it (`smbe develop local-dev-env`). Probe the image so
    bootstrap works against both."""
    probe = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--entrypoint",
            "/app/smbe",
            image_ref,
            "develop",
            "--help",
        ],
        env=dict(ctx.env),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return ["develop", "local-dev-env"] if probe.returncode == 0 else ["local-dev-env"]


def _skip_templates_args(ctx: Ctx, image_ref: str, dev_env_cmd: list[str]) -> list[str]:
    """Template seeding is done by this repo's own tooling (up runs
    seed-app-templates.mjs) instead of the seeder embedded in the backend
    image. The embedded seeder hardcodes a GraphQL query against the public
    registry, so registry schema drift breaks bootstrap for every already-built
    backend image. Skip it whenever the image supports --skip-templates; set
    LOCAL_PLATFORM_USE_BACKEND_TEMPLATE_SEEDER=1 to opt back in."""
    if ctx.truthy("LOCAL_PLATFORM_USE_BACKEND_TEMPLATE_SEEDER"):
        return []
    help_output = try_output(
        [
            "docker",
            "run",
            "--rm",
            "--entrypoint",
            "/app/smbe",
            image_ref,
            *dev_env_cmd,
            "--help",
        ],
        env=ctx.env,
        timeout=300,
    )
    if "--skip-templates" in help_output:
        log(
            "Skipping embedded template seeder (repo-owned "
            "seed-app-templates.mjs runs instead)"
        )
        return ["--skip-templates"]
    log_warn(
        "Backend image does not support --skip-templates; the embedded "
        "template seeder will run and may fail on registry schema drift"
    )
    return []


def _base64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def sign_edge_grpc_token(private_key_path: Path) -> str:
    """Mint the 30-day RS512 JWT Edge accepts on its node API.

    RS512 is RSASSA-PKCS1-v1_5 over SHA-512, which is exactly what
    `openssl dgst -sha512 -sign` produces; openssl ships on every dev machine
    and CI runner, so no crypto library is needed.
    """
    require_cmd("openssl")
    now = int(time.time())
    header = _base64url(
        json.dumps({"alg": "RS512", "typ": "JWT"}, separators=(",", ":")).encode()
    )
    payload = _base64url(
        json.dumps(
            {
                "exp": now + 30 * 24 * 60 * 60,
                "iat": now,
                "sub": "wasmerio-backend",
                "node_api_permissions": ["all"],
            },
            separators=(",", ":"),
        ).encode()
    )
    signing_input = f"{header}.{payload}"
    result = subprocess.run(
        ["openssl", "dgst", "-sha512", "-sign", str(private_key_path)],
        input=signing_input.encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0 or not result.stdout:
        fail(
            "Failed to generate Edge gRPC token: "
            + result.stderr.decode(errors="replace").strip()
        )
    return f"{signing_input}.{_base64url(result.stdout)}"


_REDACT_PATTERN = re.compile(r"((?:WASMER_TOKEN|EDGE_SYNC_TOKEN)=).+$", re.MULTILINE)


def bootstrap(ctx: Ctx) -> None:
    run_dir = ctx.require_run_dir()
    (run_dir / "edge").mkdir(parents=True, exist_ok=True)
    (run_dir / "artifacts").mkdir(parents=True, exist_ok=True)
    (run_dir / "backend.env").touch()

    image_ref = ctx.get("BACKEND_IMAGE_REF")
    compose_project = ctx.get("COMPOSE_PROJECT_NAME")

    log("Generating backend/test env with smbe local-dev-env")
    bootstrap_log = run_dir / "logs" / "bootstrap.log"
    bootstrap_raw = run_dir / ".bootstrap.raw.log"
    mysql_app_host = _detect_mysql_app_host(ctx)

    dev_env_cmd = _smbe_dev_env_subcommand(ctx, image_ref)
    log(f"Using smbe subcommand: {' '.join(dev_env_cmd)}")
    skip_templates_args = _skip_templates_args(ctx, image_ref, dev_env_cmd)

    bootstrap_cmd = [
        "docker",
        "run",
        "--rm",
        "--network",
        f"{compose_project}_default",
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        "--add-host",
        "host.docker.internal:host-gateway",
        "-v",
        f"{run_dir}:/platform",
        "-e",
        "AWS_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/wapm",
        "-e",
        "DATABASE_URL=postgresql://postgres:postgres@postgres:5432/wapm",
        "-e",
        "REDIS_URL=redis://redis:6379",
        "-e",
        "SM_BE_CACHE=redis://redis:6379/0",
        "-e",
        "SM_BE_MSGBUS=redis://redis:6379/1",
        "-e",
        "SM_BE_DATASTORE_PRIVATE_URI=s3://minioadmin:minioadmin@minio-persistent:9000/"
        "backend-datastore-private?style=path&region=us-east-1",
        "-e",
        f"SM_BE_PUBLIC_URL=http://localhost:{ctx.get('BACKEND_HTTP_PORT')}",
        "-e",
        f"SM_BE_FRONTEND_URL=http://localhost:{ctx.get('BACKEND_HTTP_PORT')}",
        "-e",
        "SM_BE_PRIMARY_APP_DOMAIN=localhost",
        "-e",
        "LOKI_URI=http://loki:3100",
        "-e",
        "METRICS_CLICKHOUSE_URL=http://default:root@clickhouse:8123/edge_metrics_local",
        "-e",
        "RUST_LOG=info",
        "-e",
        "SECRET_KEY=local-dev-secret",
        "--entrypoint",
        "/app/smbe",
        image_ref,
        *dev_env_cmd,
        "--state-dir",
        "/platform/state",
        "--namespace",
        "wasmer-integration-tests",
        "--public-url",
        "http://backend:8000",
        "--app-domain",
        "localhost",
        "--edge-server",
        f"http://127.0.0.1:{ctx.get('EDGE_HTTP_PORT')}",
        "--edge-ssh-server",
        f"ssh://127.0.0.1:{ctx.get('EDGE_SSH_PORT')}",
        "--edge-dns-server",
        f"127.0.0.1:{ctx.get('EDGE_DNS_PORT')}",
        "--mysql-host",
        mysql_app_host,
        "--mysql-port",
        ctx.get("MYSQL_APP_DB_1_PORT"),
        "--mysql-secondary-port",
        ctx.get("MYSQL_APP_DB_2_PORT"),
        "--mysql-user",
        "root",
        "--mysql-password",
        "root",
        "--loki-uri",
        "http://loki:3100",
        "--metrics-clickhouse-host",
        "clickhouse",
        "--metrics-clickhouse-port",
        "8123",
        "--write-test-env",
        "/platform/test-env.sh",
        "--write-backend-env",
        "/platform/backend.env",
        *skip_templates_args,
    ]

    status = run_quietly(
        "Bootstrap backend/test env",
        bootstrap_raw,
        bootstrap_cmd,
        env=ctx.env,
        timeout=ctx.getint("LOCAL_PLATFORM_BOOTSTRAP_TIMEOUT_SECONDS", 900),
        # The raw log contains the admin/edge-sync tokens; only the redacted
        # copy below may be printed.
        print_output_on_failure=False,
    )
    raw_text = (
        bootstrap_raw.read_text(errors="replace") if bootstrap_raw.exists() else ""
    )
    bootstrap_log.parent.mkdir(parents=True, exist_ok=True)
    bootstrap_log.write_text(_REDACT_PATTERN.sub(r"\1<redacted>", raw_text))
    if status != 0:
        sys.stderr.write(bootstrap_log.read_text(errors="replace"))
        sys.stderr.flush()
        bootstrap_raw.unlink(missing_ok=True)
        fail(f"Bootstrap failed with status {status}", status)

    log("Generating local Edge config from bootstrap outputs")
    run(
        [
            "node",
            str(ctx.repo_dir / "local-platform" / "scripts" / "generate-edge-config.mjs"),
            str(run_dir),
            str(bootstrap_raw),
            str(run_dir / "edge" / "platform_config.yaml"),
        ],
        env=ctx.env,
    )
    bootstrap_raw.unlink(missing_ok=True)

    for required in ("backend.env", "test-env.sh", "edge/platform_config.yaml"):
        path = run_dir / required
        if not path.is_file() or path.stat().st_size == 0:
            fail(f"Bootstrap did not write {path}")

    edge_grpc_token = sign_edge_grpc_token(
        run_dir / "state" / "keys" / "deploy_jwt_private_key.pem"
    )

    # The production Backend image used by local-platform carries source build
    # tooling under /opt rather than the backend repository path assumed by
    # smbe local-dev-env.
    with open(run_dir / "backend.env", "a") as backend_env:
        backend_env.write(
            "\n# local-platform source build tooling\n"
            'export PATH="/opt/source-build-tools/bin:$PATH"\n'
            'export EDGE_GRPC_ENDPOINT="edge:9051"\n'
            'export EDGE_GRPC_USE_INSECURE_CHANNEL="1"\n'
            f'export EDGE_GRPC_TOKEN="{edge_grpc_token}"\n'
        )

    # Ensure the generated test env contains the isolated integration-test
    # ports.
    with open(run_dir / "test-env.sh", "a") as test_env:
        test_env.write(
            "\n# local-platform isolated test endpoints\n"
            f'export WASMER_REGISTRY="http://localhost:{ctx.get("BACKEND_HTTP_PORT")}/graphql"\n'
            'export WASMER_APP_DOMAIN="localhost"\n'
            f'export EDGE_SERVER="http://127.0.0.1:{ctx.get("EDGE_HTTP_PORT")}"\n'
            f'export EDGE_SSH_SERVER="ssh://127.0.0.1:{ctx.get("EDGE_SSH_PORT")}"\n'
            f'export EDGE_DNS_SERVER="127.0.0.1:{ctx.get("EDGE_DNS_PORT")}"\n'
            f'export CLICKHOUSE_HTTP_PORT="{ctx.get("CLICKHOUSE_HTTP_PORT")}"\n'
            f'export LOCAL_PLATFORM_CLICKHOUSE_URL="http://localhost:{ctx.get("CLICKHOUSE_HTTP_PORT")}"\n'
            'export LOCAL_PLATFORM_CLICKHOUSE_DATABASE="edge_metrics_local"\n'
            'export LOCAL_PLATFORM_CLICKHOUSE_USERNAME="default"\n'
            'export LOCAL_PLATFORM_CLICKHOUSE_PASSWORD="root"\n'
            'export LOCAL_PLATFORM_RELAX_EDGE_VERSION_HEADER="1"\n'
        )

    log("Bootstrap complete")
