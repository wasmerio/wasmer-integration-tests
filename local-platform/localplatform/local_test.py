"""`make local-test`: boot the stack, run the requested test command against
it, and report/tear down according to the LOCAL_PLATFORM_* switches."""

from __future__ import annotations

import os

from .down import down
from .lib import (
    Ctx,
    DEFAULT_TEST_COMMAND,
    Fail,
    log,
    log_emit,
    log_warn,
    run_streaming,
)
from .up import read_test_env, up


def _default_ci_jest_workers(ctx: Ctx) -> None:
    """Integration tests are network-bound, but jest's percentage-based
    maxWorkers collapses to one worker on small CI runners, serializing whole
    test files. Give CI a core-scaled worker pool (capped: the runner also
    hosts the full local platform stack) unless the caller overrides."""
    if not ctx.is_ci() or ctx.get("JEST_MAX_WORKERS"):
        return
    cores = os.cpu_count() or 4
    workers = min(cores, 8)
    ctx.env["JEST_MAX_WORKERS"] = str(workers)
    log(f"CI detected: defaulting JEST_MAX_WORKERS={workers} ({cores} cores)")


def _run_test_command(ctx: Ctx, test_command: str) -> int:
    log(f"Running tests: {test_command}")
    env = {**ctx.env, **read_test_env(ctx, required=True)}
    env.setdefault("VERBOSE", "false")
    env.setdefault("FORCE_COLOR", "1")
    # The test command is contractually a (possibly multi-line) shell snippet
    # from .github/integration-test-suites.json or the caller. Run it under a
    # login bash with `set -euo pipefail` to mirror GitHub Actions run-step
    # semantics: multi-line suite commands fail on the first failing command
    # instead of returning the exit status of only the last line.
    return run_streaming(
        ["bash", "-lc", f"set -euo pipefail\n{test_command}"],
        ctx.require_run_dir() / "logs" / "tests.log",
        env=env,
        cwd=ctx.repo_dir,
        timeout=ctx.getint("LOCAL_PLATFORM_TEST_TIMEOUT_SECONDS", 1200),
    )


def local_test(ctx: Ctx) -> int:
    """Returns the process exit status."""
    prepare_only = ctx.truthy("LOCAL_PLATFORM_PREPARE_ONLY", "0")
    auto_down = ctx.truthy("LOCAL_PLATFORM_AUTO_DOWN", "0")
    # The caller's LOCAL_TEST_COMMAND wins over the value local.env/resolve
    # record, so `LOCAL_TEST_COMMAND=... make local-test` always runs exactly
    # what was asked.
    requested_test_command = os.environ.get("LOCAL_TEST_COMMAND", "")

    stack_ready = False
    exit_code = 0
    try:
        up(ctx)
        stack_ready = True
        if ctx.run_dir is None or not ctx.get("COMPOSE_PROJECT_NAME"):
            ctx.load_resolved_env()

        if not prepare_only:
            test_command = (
                requested_test_command
                or ctx.get("LOCAL_TEST_COMMAND")
                or DEFAULT_TEST_COMMAND
            )
            _default_ci_jest_workers(ctx)
            exit_code = _run_test_command(ctx, test_command)
    except KeyboardInterrupt:
        exit_code = 130
    except Fail as error:
        log_emit("ERROR", str(error))
        exit_code = error.code
    except Exception as error:
        # Mirror the bash EXIT trap: whatever went wrong, still run the
        # teardown/keep-running logic below and report a final status.
        log_emit("ERROR", f"{type(error).__name__}: {error}")
        exit_code = 1

    if stack_ready:
        if auto_down:
            if exit_code != 0 and ctx.truthy("LOCAL_PLATFORM_KEEP_RUNNING_ON_FAILURE"):
                log_warn(
                    "LOCAL_PLATFORM_KEEP_RUNNING_ON_FAILURE is set; leaving the "
                    "local platform running for inspection"
                )
            else:
                try:
                    down(ctx)
                except Exception as error:
                    log_warn(f"Teardown failed: {error}")
        else:
            log(
                "Leaving local platform running; tear down manually with "
                "make local-platform-down"
            )

    label = "prepare-test-environment" if prepare_only else "local-test"
    if exit_code == 0:
        log(
            "Prepared local platform test environment"
            if prepare_only
            else "local-test passed"
        )
    else:
        log(f"{label} failed with status {exit_code}")
    return exit_code
