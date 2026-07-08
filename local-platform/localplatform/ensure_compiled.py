"""Warm the Edge compiler cache for the seeded package set before tests run."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from .lib import (
    Ctx,
    compose_cmd,
    fail,
    log,
    log_warn,
    require_cmd,
    run,
    run_streaming,
    try_output,
)


def _build_package_list(
    seed_diagnostics_path: Path, extra_list_path: Path, output_path: Path
) -> list[str]:
    """Union of the seeded package pins and the repo's extra compilation list,
    deduplicated in order, with comments stripped."""
    packages: list[str] = []
    seen: set[str] = set()

    def add(raw: str) -> None:
        value = (raw or "").strip()
        if not value or value.startswith("#"):
            return
        value = re.sub(r"\s+#.*$", "", value).strip()
        if not value or value in seen:
            return
        seen.add(value)
        packages.append(value)

    if seed_diagnostics_path.exists():
        diagnostics = json.loads(seed_diagnostics_path.read_text())
        for package in diagnostics.get("resolved") or []:
            name = (package or {}).get("resolvedName")
            version = (package or {}).get("resolvedVersion")
            if name and version:
                add(f"{name}@={version}")

    if extra_list_path.exists():
        for line in extra_list_path.read_text().splitlines():
            add(line)

    output_path.write_text("\n".join(packages) + "\n")
    return packages


def ensure_compiled(ctx: Ctx) -> None:
    if not ctx.truthy("LOCAL_PLATFORM_ENSURE_COMPILED", "1"):
        log(
            "Skipping package precompilation because LOCAL_PLATFORM_ENSURE_COMPILED="
            f"{ctx.get('LOCAL_PLATFORM_ENSURE_COMPILED')}"
        )
        return

    require_cmd("docker")
    run_dir = ctx.require_run_dir()
    (run_dir / "logs").mkdir(parents=True, exist_ok=True)
    (run_dir / "diagnostics").mkdir(parents=True, exist_ok=True)

    seed_diagnostics = run_dir / "diagnostics" / "package-seed.json"
    extra_list = ctx.repo_dir / "local-platform" / "package-compilation-list.txt"
    resolved_list = run_dir / "diagnostics" / "package-compilation-list.resolved.txt"

    if ctx.truthy("LOCAL_PLATFORM_SEED_PACKAGES", "1") and not seed_diagnostics.is_file():
        fail(
            f"Package seeding is enabled but {seed_diagnostics} is missing; "
            "cannot precompile the seeded package set"
        )

    packages = _build_package_list(seed_diagnostics, extra_list, resolved_list)
    if not packages:
        log("No packages selected for Edge precompilation")
        return

    log(f"Selected {len(packages)} package(s) for Edge precompilation")
    log(f"Package precompilation list: {resolved_list}")
    for package in packages:
        log(f"  precompile: {package}")

    log("Building Edge runtime helper image for precompilation")
    run(compose_cmd(ctx, "build", "edge"), env=ctx.env, stdout=subprocess.DEVNULL)

    compose_project = ctx.get("COMPOSE_PROJECT_NAME")
    edge_helper_image = f"{compose_project}-edge:latest"
    edge_network = f"{compose_project}_default"

    if not try_output(
        ["docker", "image", "inspect", edge_helper_image, "--format", "{{.Id}}"],
        env=ctx.env,
    ):
        fail(f"Expected Edge helper image {edge_helper_image} after compose build")
    if not try_output(
        ["docker", "network", "inspect", edge_network, "--format", "{{.Id}}"],
        env=ctx.env,
    ):
        fail(f"Expected Compose network {edge_network} before precompilation")

    engines = [
        engine.strip()
        for engine in (
            ctx.get("LOCAL_PLATFORM_ENSURE_COMPILED_ENGINES") or "wasmer-cranelift"
        ).split(",")
        if engine.strip()
    ]
    threads_cli: list[str] = []
    threads = ctx.get("LOCAL_PLATFORM_ENSURE_COMPILED_THREADS")
    if threads:
        try:
            if int(threads) > 0:
                threads_cli = ["--threads", threads]
        except ValueError:
            log_warn(
                "Ignoring non-integer LOCAL_PLATFORM_ENSURE_COMPILED_THREADS="
                f"{threads}"
            )

    timeout = ctx.getint("LOCAL_PLATFORM_ENSURE_COMPILED_TIMEOUT_SECONDS", 1800)
    edge_cache_dir = ctx.edge_cache_dir()

    for engine in engines:
        safe_engine = re.sub(r"[^A-Za-z0-9_.-]", "_", engine)
        compile_log = run_dir / "logs" / f"ensure-compiled.{safe_engine}.log"
        log(
            f"Ensuring Edge compiler cache is warm for engine={engine} "
            f"({len(packages)} package(s))"
        )

        # The helper container proxies 127.0.0.1:18000 to the backend service
        # so package downloads resolve inside the compose network.
        status = run_streaming(
            [
                "docker",
                "run",
                "--rm",
                "--init",
                "--user",
                "0:0",
                "--network",
                edge_network,
                "-v",
                f"{run_dir / 'artifacts' / 'edge'}:/usr/local/bin/edge:ro",
                "-v",
                f"{run_dir / 'edge' / 'platform_config.yaml'}:/config/platform_config.yaml:ro",
                "-v",
                f"{edge_cache_dir / 'compiler_cache'}:/data/compiler_cache",
                "-v",
                f"{edge_cache_dir / 'webc_cache'}:/data/webc_cache",
                "--entrypoint",
                "/bin/sh",
                edge_helper_image,
                "-lc",
                'socat TCP-LISTEN:18000,bind=127.0.0.1,fork,reuseaddr'
                ' TCP:backend:8000 & exec "$@"',
                "sh",
                "/usr/local/bin/edge",
                "local",
                "ensure-compiled",
                "--config-path",
                "/config/platform_config.yaml",
                "--data-dir",
                "/data",
                "--scan-filesystem",
                "--engine",
                engine,
                *threads_cli,
                *packages,
            ],
            compile_log,
            env=ctx.env,
            timeout=timeout,
        )
        if status != 0:
            fail(
                f"Edge precompilation failed for engine={engine} with status "
                f"{status}; see {compile_log}",
                status,
            )

    log("Edge package precompilation complete")
