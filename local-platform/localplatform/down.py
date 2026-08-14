"""Tear down the compose stack for the current (or given) run."""

from __future__ import annotations

import os
import signal

from .lib import Ctx, compose, fail, log_warn, process_is_running
from .logs import collect_logs
from .seed import release_held_scenarios


def stop_log_follower(ctx: Ctx) -> None:
    pid_file = ctx.require_run_dir() / "logs" / "compose.follow.pid"
    if not pid_file.is_file():
        return
    try:
        pid = int(pid_file.read_text().strip() or "0")
    except ValueError:
        pid = 0
    if process_is_running(pid):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    pid_file.unlink(missing_ok=True)


def stop(ctx: Ctx) -> None:
    """Suspend the stack: containers and volumes stay, so `up` resumes this
    same run - with its migrated database, its bootstrapped admin token and
    whatever state was seeded into it - in seconds instead of rebuilding it
    from an empty volume. `down` remains the destructive verb."""
    if ctx.run_dir is None:
        current = ctx.current_run_dir()
        if current is None or not (current / "resolved.env").is_file():
            fail("No current local platform run found")
        ctx.run_dir = current
    ctx.load_resolved_env()
    # The default SIGTERM grace is ten seconds per container and most of
    # them exit immediately; three keeps the suspend snappy without cutting
    # a database off mid-flush.
    compose(ctx, "stop", "--timeout", ctx.get("LOCAL_PLATFORM_STOP_TIMEOUT") or "3")
    stop_log_follower(ctx)


def down(ctx: Ctx, *, skip_collect: bool | None = None) -> None:
    if ctx.run_dir is None:
        current = ctx.current_run_dir()
        if current is None or not (current / "resolved.env").is_file():
            fail("No current local platform run found")
        ctx.run_dir = current

    ctx.package_cache_dir()
    ctx.edge_cache_dir()
    ctx.load_resolved_env()

    if skip_collect is None:
        skip_collect = ctx.truthy("LOCAL_PLATFORM_SKIP_COLLECT_ON_DOWN")
    if not skip_collect:
        try:
            collect_logs(ctx)
        except Exception as error:
            log_warn(f"Log collection failed: {error}")

    compose(
        ctx,
        "down",
        "--remove-orphans",
        "--volumes",
        "--timeout",
        ctx.get("LOCAL_PLATFORM_STOP_TIMEOUT") or "3",
    )
    stop_log_follower(ctx)
    # Platform first, then fast-release: volumes died, so every teardown
    # entry is satisfied by construction (D-5).
    release_held_scenarios(ctx)
