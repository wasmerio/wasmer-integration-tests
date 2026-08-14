"""Seed binding and hooks: `[seed].scenarios` and `[hooks].post_up` (D-5/D-6).

`up()` seeds each declared scenario via `./bin/ass up --file <abs>` after the
platform is serving, then runs the consumer's post_up hook; `down()` releases
every held simulator descriptor after platform teardown (volumes already
died, so teardown entries are satisfied by construction — the fast-release
path). `LOCAL_PLATFORM_SCENARIOS` (comma-separated, resolved against cwd) is
the one-off override; the empty string boots unseeded.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from .lib import (
    Ctx,
    fail,
    log_step,
    log_warn,
    run,
    run_quietly,
    run_streaming,
)

SCENARIOS_OVERRIDE = "LOCAL_PLATFORM_SCENARIOS"


def _ass_path(ctx: Ctx) -> Path:
    return ctx.repo_dir / "bin" / "ass"


def _ass_ready(ctx: Ctx) -> bool:
    return (
        _ass_path(ctx).is_file()
        and (ctx.repo_dir / "node_modules" / ".bin" / "tsx").exists()
    )


def _ass_env(ctx: Ctx) -> dict[str, str]:
    env = dict(ctx.env)
    # ASS self-presents; through our pipe, hand it the terminal's colors and
    # width (NO_COLOR wins, explicit FORCE_COLOR/COLUMNS win).
    if sys.stdout.isatty():
        if "FORCE_COLOR" not in env and not env.get("NO_COLOR"):
            env["FORCE_COLOR"] = "1"
        env.setdefault("COLUMNS", str(shutil.get_terminal_size().columns))
    return env


def scenario_files(ctx: Ctx) -> list[Path]:
    """The scenario list to seed: the env override wins over the config."""
    override = ctx.env.get(SCENARIOS_OVERRIDE)
    if override is not None:
        return [
            Path(part.strip()).resolve()
            for part in override.split(",")
            if part.strip()
        ]
    if ctx.config is None:
        return []
    return list(ctx.config.seed_scenarios)


def seed_scenarios(ctx: Ctx) -> None:
    scenarios = scenario_files(ctx)
    if not scenarios:
        return
    if not _ass_ready(ctx):
        # A declared seed is a promise, not a hint.
        fail(
            "Seed scenarios are declared but ./bin/ass cannot run "
            "(dependencies are not installed); run `make setup` first"
        )
    for scenario in scenarios:
        if not scenario.is_file():
            fail(f"Seed scenario does not exist: {scenario}")
    for index, scenario in enumerate(scenarios, start=1):
        log_step(f"Seeding scenario {scenario.name} ({index}/{len(scenarios)})")
        status = run_streaming(
            [str(_ass_path(ctx)), "up", "--file", str(scenario)],
            ctx.require_run_dir() / "logs" / f"seed-{index}-{scenario.stem}.log",
            env=_ass_env(ctx),
            cwd=ctx.repo_dir,
        )
        if status != 0:
            fail(f"Seeding scenario {scenario} failed with status {status}", status)


def run_post_up_hook(ctx: Ctx) -> None:
    config = ctx.config
    if config is None or not config.post_up:
        return
    from .up import read_test_env

    log_step(f"Running post_up hook: {config.post_up}")
    log_file = ctx.require_run_dir() / "logs" / "post-up-hook.log"
    status = run_quietly(
        "post_up hook",
        log_file,
        ["bash", "-c", config.post_up],
        env={**ctx.env, **read_test_env(ctx, required=True)},
        cwd=config.post_up_dir,
        echo_prefix="[post_up] ",
    )
    if status != 0:
        fail(
            f"post_up hook failed with status {status}: {config.post_up} "
            f"(output above; log: {log_file})",
            status,
        )


def release_held_scenarios(ctx: Ctx) -> None:
    """`down()` symmetry: release what was seeded (best-effort, warn on
    failure so platform teardown never blocks on the simulator)."""
    if not _ass_ready(ctx):
        return
    result = run(
        [str(_ass_path(ctx)), "status", "--json"],
        env=ctx.env,
        cwd=ctx.repo_dir,
        check=False,
        capture=True,
        timeout=120,
    )
    if result.returncode != 0:
        log_warn("ass status --json failed; held scenario descriptors not released")
        return
    try:
        held = json.loads(result.stdout.decode() or "{}").get("held", [])
    except json.JSONDecodeError:
        held = []
    slugs = [
        entry["slug"]
        for entry in held
        if isinstance(entry, dict) and entry.get("slug")
    ]
    for slug in slugs:
        log_step(f"Releasing held scenario '{slug}'")
        status = run_streaming(
            [str(_ass_path(ctx)), "down", slug],
            ctx.require_run_dir() / "logs" / f"ass-down-{slug}.log",
            env=_ass_env(ctx),
            cwd=ctx.repo_dir,
        )
        if status != 0:
            log_warn(f"ASS teardown failed — re-run: ./bin/ass down {slug}")
