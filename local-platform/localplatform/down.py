"""Tear down the compose stack for the current (or given) run."""

from __future__ import annotations

import os
import signal

from .lib import Ctx, compose, fail, log_warn, process_is_running
from .logs import collect_logs


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

    compose(ctx, "down", "--remove-orphans", "--volumes")
    stop_log_follower(ctx)
