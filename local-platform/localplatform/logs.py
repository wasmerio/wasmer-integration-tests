"""Log/diagnostic collection and printing for the current (or given) run."""

from __future__ import annotations

import subprocess
import sys

from .lib import Ctx, compose_cmd, fail, log, tail_lines

SERVICES = (
    "backend",
    "edge",
    "postgres",
    "redis",
    "mysql_app_db_1",
    "mysql_app_db_2",
    "minio_persistent",
    "clickhouse",
    "loki",
    "vector",
)


def _capture(ctx: Ctx, cmd: list[str], destination) -> None:
    """Run a diagnostic command, streaming combined output to `destination`.
    Failures are recorded in the file rather than raised: diagnostics are
    best-effort by design. The timeout only guards against hangs; partial
    output written before it fires is kept."""
    try:
        with open(destination, "wb") as handle:
            subprocess.run(
                cmd,
                env=dict(ctx.env),
                stdout=handle,
                stderr=subprocess.STDOUT,
                timeout=300,
            )
    except (OSError, subprocess.TimeoutExpired) as error:
        try:
            with open(destination, "ab") as handle:
                handle.write(f"\n<collection interrupted: {error}>\n".encode())
        except OSError:
            pass


def collect_logs(ctx: Ctx) -> None:
    run_dir = ctx.require_run_dir()
    logs_dir = run_dir / "logs"
    diagnostics_dir = run_dir / "diagnostics"
    logs_dir.mkdir(parents=True, exist_ok=True)
    diagnostics_dir.mkdir(parents=True, exist_ok=True)

    _capture(ctx, compose_cmd(ctx, "ps"), logs_dir / "compose.ps.txt")
    _capture(
        ctx,
        compose_cmd(ctx, "ps", "--format", "json"),
        diagnostics_dir / "docker-compose-ps.json",
    )
    _capture(
        ctx, compose_cmd(ctx, "config"), diagnostics_dir / "docker-compose-config.yaml"
    )
    _capture(ctx, compose_cmd(ctx, "top"), diagnostics_dir / "docker-compose-top.txt")
    _capture(ctx, ["df", "-h"], diagnostics_dir / "disk-usage.txt")
    _capture(
        ctx, ["du", "-h", "-d", "3", str(run_dir)], diagnostics_dir / "run-dir-sizes.txt"
    )
    package_cache = ctx.local_platform_dir / "package-cache"
    if package_cache.is_dir():
        _capture(
            ctx,
            ["du", "-h", "-d", "2", str(package_cache)],
            diagnostics_dir / "package-cache-sizes.txt",
        )

    container_ids_result = subprocess.run(
        compose_cmd(ctx, "ps", "-q"),
        env=dict(ctx.env),
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    container_ids = container_ids_result.stdout.decode().split()
    if container_ids:
        _capture(
            ctx,
            [
                "docker",
                "stats",
                "--no-stream",
                "--format",
                "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}",
                *container_ids,
            ],
            diagnostics_dir / "docker-stats.txt",
        )

    for service in SERVICES:
        _capture(
            ctx,
            compose_cmd(ctx, "logs", "--no-color", "--timestamps", service),
            logs_dir / f"{service}.log",
        )

    log(f"Collected logs and diagnostics in {run_dir}")


def print_logs(ctx: Ctx) -> None:
    if ctx.run_dir is None:
        current = ctx.current_run_dir()
        if current is None:
            fail("No current local platform run found")
        ctx.run_dir = current

    log_dir = ctx.require_run_dir() / "logs"
    if not log_dir.is_dir():
        fail(f"No logs directory found: {log_dir}")

    line_count = ctx.getint("LOCAL_PLATFORM_LOG_LINES", 200)
    files = sorted(log_dir.glob("*.log")) + sorted(log_dir.glob("*.txt"))
    for file in files:
        print(f"\n===== {file.relative_to(ctx.require_run_dir())} =====")
        try:
            sys.stdout.writelines(tail_lines(file, line_count))
        except OSError as error:
            print(f"<failed to read: {error}>")
        sys.stdout.flush()
