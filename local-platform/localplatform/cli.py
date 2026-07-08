"""Command-line dispatch for the local platform tooling."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .lib import Ctx, Fail, log_emit

COMMANDS = ("up", "down", "local-test", "prepare", "logs", "collect-logs", "status")


def _make_ctx() -> Ctx:
    ctx = Ctx()
    # Honor an explicit RUN_DIR (the previous scripts accepted it for down /
    # logs against a non-current run).
    run_dir = os.environ.get("RUN_DIR")
    if run_dir:
        ctx.run_dir = Path(run_dir).resolve()
    return ctx


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="local-platform",
        description="Boot, test against, and tear down the disposable local "
        "Wasmer platform.",
    )
    parser.add_argument("command", choices=COMMANDS)
    args = parser.parse_args(argv)

    ctx = _make_ctx()
    try:
        if args.command == "up":
            from .up import up

            up(ctx)
            return 0
        if args.command == "down":
            from .down import down

            down(ctx)
            return 0
        if args.command == "local-test":
            from .local_test import local_test

            return local_test(ctx)
        if args.command == "prepare":
            from .local_test import local_test

            ctx.env["LOCAL_PLATFORM_PREPARE_ONLY"] = "1"
            return local_test(ctx)
        if args.command == "logs":
            from .logs import print_logs

            print_logs(ctx)
            return 0
        if args.command == "collect-logs":
            from .logs import collect_logs

            ctx.load_resolved_env()
            collect_logs(ctx)
            return 0
        if args.command == "status":
            from .status import status

            return status(ctx)
    except Fail as error:
        log_emit("ERROR", str(error))
        return error.code
    except KeyboardInterrupt:
        return 130
    raise AssertionError(f"unhandled command: {args.command}")
