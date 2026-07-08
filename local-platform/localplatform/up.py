"""Boot (or reuse) the disposable local platform stack."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Callable

from . import bootstrap as bootstrap_mod
from . import ensure_compiled as ensure_compiled_mod
from . import fetch as fetch_mod
from . import resolve as resolve_mod
from .down import down, stop_log_follower
from .lib import (
    ANSI_BOLD,
    ANSI_CYAN,
    ANSI_DIM_GRAY,
    ANSI_GREEN,
    ANSI_RESET,
    ANSI_YELLOW,
    Ctx,
    Fail,
    check_required_ports_available,
    compose,
    compose_cmd,
    compose_project_has_running_containers,
    compose_service_is_running,
    describe_backend_version,
    describe_edge_version,
    ensure_github_token,
    fail,
    log,
    log_clear,
    log_use_color,
    log_warn,
    parse_env_file,
    process_is_running,
    require_cmd,
    run_quietly,
    try_output,
    wait_url,
)
from .logs import collect_logs

DEPENDENCY_SERVICES = (
    "postgres",
    "redis",
    "mysql_app_db_1",
    "mysql_app_db_2",
    "minio_persistent",
    "minio_persistent_init",
    "clickhouse",
    "loki",
    "vector",
)

# Selectors that need a GitHub token to resolve or download.
_BACKEND_TOKEN_SELECTORS = ("resolve_dev", "latest_dev", "latest-dev")
_BACKEND_TOKEN_PREFIXES = ("artifact:", "github-artifact:", "github-release:")
_EDGE_TOKEN_SELECTORS = ("resolve_prod", "resolve_dev", "latest_dev", "latest-dev")
_EDGE_TOKEN_PREFIXES = ("github-artifact:", "github-release:")


def load_local_env(ctx: Ctx) -> None:
    """Layer local.env over the caller environment (matching the previous
    `set -a; source local.env` semantics: local.env values win)."""
    local_env_file = ctx.repo_dir / "local.env"
    if not local_env_file.is_file():
        return
    log("Loading local.env")
    values = parse_env_file(local_env_file, base_env=ctx.env)
    ctx.env.update(values)
    # The logging helpers read these from os.environ (they have no ctx);
    # propagate them so a VERBOSE=true in local.env affects our own output,
    # like sourcing did.
    for name in ("VERBOSE", "NO_COLOR", "LOCAL_PLATFORM_DISABLE_INLINE_PROGRESS"):
        if name in values:
            os.environ[name] = values[name]


def start_compose_log_follow(ctx: Ctx) -> None:
    """Keep a detached `docker compose logs --follow` writing the combined
    service log for this run; reuse it if one is already running."""
    logs_dir = ctx.require_run_dir() / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    pid_file = logs_dir / "compose.follow.pid"

    if pid_file.is_file():
        try:
            existing_pid = int(pid_file.read_text().strip() or "0")
        except ValueError:
            existing_pid = 0
        if process_is_running(existing_pid):
            return

    log_handle = open(logs_dir / "compose.follow.log", "wb")
    try:
        process = subprocess.Popen(
            compose_cmd(ctx, "logs", "--no-color", "--timestamps", "--follow"),
            env=dict(ctx.env),
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # outlives this process, like nohup
        )
    finally:
        log_handle.close()
    pid_file.write_text(f"{process.pid}\n")


def read_test_env(ctx: Ctx, *, required: bool = False) -> dict[str, str]:
    """The generated test-env.sh as a dict. `required` callers (running tests
    or seeding) must fail rather than silently proceed against whatever
    backend the caller's environment happens to point at."""
    test_env_file = ctx.require_run_dir() / "test-env.sh"
    if not test_env_file.is_file():
        if required:
            fail(f"Missing generated test env: {test_env_file}")
        return {}
    return parse_env_file(test_env_file, base_env=ctx.env)


def _local_admin_username(ctx: Ctx, test_env: dict[str, str]) -> str:
    if shutil.which("wasmer"):
        whoami = try_output(["wasmer", "whoami"], env={**ctx.env, **test_env})
        match = re.search(
            r"^Logged into registry .* as user (\S+)$", whoami, re.MULTILINE
        )
        if match:
            return match.group(1)
    return "local-dev"


def _write_github_step_summary(
    ctx: Ctx, backend_version: str, edge_version: str
) -> None:
    """Surface the running versions on the GitHub Actions job page (both the
    prepare gate and each suite job), so nobody digs through logs to learn
    what a pipeline run actually tested."""
    summary_path = ctx.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return
    try:
        with open(summary_path, "a") as summary:
            summary.write(
                "### Local platform versions\n\n"
                "| Component | Running |\n"
                "| --- | --- |\n"
                f"| Backend | `{backend_version}` |\n"
                f"| Edge | `{edge_version}` |\n"
                f"| Selectors | backend=`{ctx.get('BACKEND_VERSION')}` "
                f"edge=`{ctx.get('EDGE_VERSION')}` |\n"
                f"| Run directory | `{ctx.require_run_dir()}` |\n\n"
            )
    except OSError as error:
        log_warn(f"Could not write GitHub step summary: {error}")


def print_access_summary(ctx: Ctx) -> None:
    run_dir = ctx.require_run_dir()
    test_env = read_test_env(ctx)
    admin_username = _local_admin_username(ctx, test_env)
    admin_token = test_env.get("WASMER_TOKEN", "")
    backend_version = describe_backend_version(ctx)
    edge_version = describe_edge_version(ctx)
    _write_github_step_summary(ctx, backend_version, edge_version)

    if log_use_color():
        reset, dim, cyan, green, yellow, bold = (
            ANSI_RESET,
            ANSI_DIM_GRAY,
            ANSI_CYAN,
            ANSI_GREEN,
            ANSI_YELLOW,
            ANSI_BOLD,
        )
    else:
        reset = dim = cyan = green = yellow = bold = ""
    rule = "─" * 76

    def port(name: str) -> str:
        return ctx.get(name)

    log_clear()
    sys.stderr.write(
        f"""
{bold}{cyan}Local platform is running{reset}
{cyan}{rule}{reset}

{cyan}┌{rule}{reset}
{cyan}│{reset} {bold}Run directory{reset}
{cyan}│{reset} {run_dir}
{cyan}│{reset} Current env: {dim}source {run_dir}/test-env.sh{reset}
{cyan}└{rule}{reset}

{cyan}┌{rule}{reset}
{cyan}│{reset} {bold}Versions{reset}
{cyan}│{reset} {dim}Backend{reset} {green}{backend_version}{reset}
{cyan}│{reset} {dim}Edge   {reset} {green}{edge_version}{reset}
{cyan}└{rule}{reset}

{cyan}┌{rule}{reset}
{cyan}│{reset} {bold}How to use it{reset}
{cyan}│{reset} {dim}Load local env (sets WASMER_REGISTRY, WASMER_TOKEN, EDGE_SERVER, etc.){reset}
{cyan}│{reset}   {green}source {run_dir}/test-env.sh{reset}
{cyan}│{reset} {dim}Run a targeted local test{reset}
{cyan}│{reset}   {green}pnpm exec jest tests/validation/log.test.ts --runInBand{reset}
{cyan}│{reset} {dim}Inspect apps / auth{reset}
{cyan}│{reset}   {green}wasmer app list{reset}
{cyan}│{reset}   {green}wasmer whoami{reset}
{cyan}│{reset} {dim}Local admin{reset} user={yellow}{admin_username}{reset} token={yellow}{admin_token}{reset}
{cyan}│{reset} {dim}Key env{reset} WASMER_REGISTRY={green}http://localhost:{port('BACKEND_HTTP_PORT')}/graphql{reset} EDGE_SERVER={green}http://127.0.0.1:{port('EDGE_HTTP_PORT')}{reset}
{cyan}│{reset} {dim}Stop everything{reset}
{cyan}│{reset}   {yellow}make local-platform-down{reset}
{cyan}└{rule}{reset}

{cyan}┌{rule}{reset}
{cyan}│{reset} {bold}Primary endpoints{reset}
{cyan}│{reset} {dim}Backend GraphQL / registry{reset} {green}http://localhost:{port('BACKEND_HTTP_PORT')}/graphql{reset}
{cyan}│{reset} {dim}Edge HTTP                 {reset} {green}http://127.0.0.1:{port('EDGE_HTTP_PORT')}{reset}
{cyan}│{reset} {dim}Edge HTTPS                {reset} {green}https://127.0.0.1:{port('EDGE_HTTPS_PORT')}{reset}
{cyan}│{reset} {dim}Edge SSH                  {reset} {green}ssh://127.0.0.1:{port('EDGE_SSH_PORT')}{reset}
{cyan}│{reset} {dim}Edge DNS                  {reset} {green}127.0.0.1:{port('EDGE_DNS_PORT')}{reset}
{cyan}└{rule}{reset}

{cyan}┌{rule}{reset}
{cyan}│{reset} {bold}Observability and services{reset}
{cyan}│{reset} {dim}Compose logs{reset}   {run_dir}/logs/compose.follow.log
{cyan}│{reset} {dim}Follow logs{reset}   {yellow}make local-platform-logs{reset}
{cyan}│{reset} {dim}Loki{reset}           {green}http://localhost:{port('LOKI_PORT')}{reset}
{cyan}│{reset} {dim}Vector{reset}         {green}http://127.0.0.1:{port('VECTOR_HTTP_PORT')}{reset}
{cyan}│{reset} {dim}ClickHouse{reset}     {green}http://localhost:{port('CLICKHOUSE_HTTP_PORT')}{reset} {dim}(db={yellow}edge_metrics_local{reset}{dim} user={yellow}default{reset}{dim} password={yellow}root{reset}{dim}){reset}
{cyan}│{reset} {dim}Postgres{reset}       localhost:{port('POSTGRES_PORT')} {dim}(db={yellow}wapm{reset}{dim} user={yellow}postgres{reset}{dim} password={yellow}postgres{reset}{dim}){reset}
{cyan}│{reset} {dim}Redis{reset}          localhost:{port('REDIS_PORT')}
{cyan}│{reset} {dim}MySQL app DB{reset}   localhost:{port('MYSQL_APP_DB_1_PORT')} {dim}(user={yellow}root{reset}{dim} password={yellow}root{reset}{dim}){reset}
{cyan}└{rule}{reset}

"""
    )
    sys.stderr.flush()


def _wait_for_backend(ctx: Ctx) -> None:
    wait_url(
        f"http://localhost:{ctx.get('BACKEND_HTTP_PORT')}/graphql",
        ctx.getint("LOCAL_PLATFORM_BACKEND_TIMEOUT_MS", 120000),
    )


def _wait_for_edge(ctx: Ctx) -> None:
    wait_url(
        f"http://127.0.0.1:{ctx.get('EDGE_HTTP_PORT')}/",
        ctx.getint("LOCAL_PLATFORM_EDGE_TIMEOUT_MS", 120000),
    )


def reuse_existing_run_if_running(ctx: Ctx) -> bool:
    """Reuse .local-platform/current when its selectors match and containers
    are still up. If the selectors changed, tear the old stack down first."""
    existing_run_dir = ctx.current_run_dir()
    if existing_run_dir is None:
        return False
    existing_resolved_env = existing_run_dir / "resolved.env"
    if not existing_resolved_env.is_file():
        return False

    try:
        existing = parse_env_file(existing_resolved_env)
    except Exception as error:
        log_warn(f"Could not read {existing_resolved_env}: {error}")
        existing = {}
    if existing.get("BACKEND_VERSION") != ctx.get("BACKEND_VERSION") or existing.get(
        "EDGE_VERSION"
    ) != ctx.get("EDGE_VERSION"):
        log("Stopping existing local platform run because the requested selectors changed")
        log(
            f"Existing selectors: backend={existing.get('BACKEND_VERSION', '')} "
            f"edge={existing.get('EDGE_VERSION', '')}"
        )
        log(
            f"Requested selectors: backend={ctx.get('BACKEND_VERSION')} "
            f"edge={ctx.get('EDGE_VERSION')}"
        )
        # Tear down with a separate context: down() loads the OLD run's
        # resolved env, which must not clobber the freshly requested selectors
        # this run resolves with. Best-effort: if teardown fails, fall through
        # to a fresh boot — the port availability check will catch anything
        # still holding the ports, with a clearer message.
        old_ctx = Ctx(env=dict(ctx.env))
        old_ctx.run_dir = existing_run_dir
        try:
            down(old_ctx, skip_collect=True)
        except Exception as error:
            log_warn(f"Teardown of the previous run failed: {error}")
        return False

    ctx.run_dir = existing_run_dir
    ctx.load_resolved_env()

    if not compose_project_has_running_containers(ctx):
        return False

    (ctx.require_run_dir() / "logs").mkdir(parents=True, exist_ok=True)
    log(f"Reusing existing local platform run: {ctx.require_run_dir()}")

    if not (
        compose_service_is_running(ctx, "backend")
        and compose_service_is_running(ctx, "edge")
    ):
        log("Found a partially running Compose project; ensuring services are up")
        compose(ctx, "up", "-d", *DEPENDENCY_SERVICES)
        compose(ctx, "up", "-d", "backend")
        _wait_for_backend(ctx)
        compose(ctx, "up", "-d", "edge")
        _wait_for_edge(ctx)

    start_compose_log_follow(ctx)
    print_access_summary(ctx)
    return True


def _create_run_dir(ctx: Ctx) -> None:
    short_sha = (
        try_output(
            ["git", "-C", str(ctx.repo_dir), "rev-parse", "--short", "HEAD"],
            env=ctx.env,
        )
        or "local"
    )
    timestamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    run_dir = ctx.local_platform_dir / "runs" / f"{timestamp}-{short_sha}"
    compose_project = f"wit_{timestamp}_{short_sha}".lower().replace("-", "_")

    ctx.run_dir = run_dir
    ctx.env["COMPOSE_PROJECT_NAME"] = compose_project
    ctx.set_run_dir_env()

    for directory in (
        run_dir / "logs",
        run_dir / "diagnostics",
        run_dir / "edge",
        run_dir / "artifacts",
        ctx.package_cache_dir(),
        ctx.edge_cache_dir() / "compiler_cache",
        ctx.edge_cache_dir() / "webc_cache",
    ):
        directory.mkdir(parents=True, exist_ok=True)

    current = ctx.local_platform_dir / "current"
    if current.is_symlink() or current.exists():
        current.unlink()
    current.symlink_to(Path("runs") / run_dir.name)

    (run_dir / "backend.env").touch()
    (run_dir / "edge" / "platform_config.yaml").touch()


def _needs_github_token(ctx: Ctx) -> bool:
    backend = ctx.get("BACKEND_VERSION")
    edge = ctx.get("EDGE_VERSION")
    return (
        backend in _BACKEND_TOKEN_SELECTORS
        or backend.startswith(_BACKEND_TOKEN_PREFIXES)
        or edge in _EDGE_TOKEN_SELECTORS
        or edge.startswith(_EDGE_TOKEN_PREFIXES)
    )


def _step(ctx: Ctx, name: str, fn: Callable[[], None]) -> None:
    """Run one boot step, recording its wall time under `name` for
    diagnostics/timings.json."""
    started = time.monotonic()
    try:
        fn()
    finally:
        ctx.record_timing(name, time.monotonic() - started)


def _await_steps(futures: dict[str, Future], *names: str) -> None:
    """Barrier on the named background steps; the first failure propagates
    with the step named, so cleanup can say exactly what died."""
    for name in names:
        future = futures.pop(name, None)
        if future is None:
            continue
        try:
            future.result()
        except BaseException:
            log_warn(f"Boot step '{name}' failed")
            raise


def _drain_remaining(futures: dict[str, Future]) -> None:
    """Wait out still-running background steps after a failure. Their child
    processes cannot be interrupted from here, so this can take as long as an
    in-flight download; secondary failures are logged, not raised."""
    if futures:
        log_warn(
            "Waiting for in-flight boot steps to settle: "
            + ", ".join(futures.keys())
        )
    for name, future in list(futures.items()):
        try:
            future.result()
        except BaseException as error:
            log_warn(f"Boot step '{name}' also failed: {error}")
    futures.clear()


def _compose_up(ctx: Ctx, label: str, prefix: str, *services: str) -> None:
    """`compose up -d` with captured output: compose's interactive redraw UI
    must not share the terminal with concurrent steps, and its CI lines get
    the same attribution prefix as the other parallel steps."""
    slug = label.lower().replace(" ", "-")
    status = run_quietly(
        label,
        ctx.require_run_dir() / "logs" / f"compose-up-{slug}.log",
        compose_cmd(ctx, "up", "-d", *services),
        env=ctx.env,
        echo_prefix=prefix,
    )
    if status != 0:
        fail(f"{label} failed to start with status {status}", status)


def _start_dependency_services(ctx: Ctx) -> None:
    log("Starting dependency services")
    _compose_up(ctx, "Dependency services", "[deps] ", *DEPENDENCY_SERVICES)
    start_compose_log_follow(ctx)


def _build_edge_helper(ctx: Ctx) -> None:
    """Pre-build the Edge runtime helper image while artifacts download; the
    later `compose build edge` in ensure_compiled then hits the build cache."""
    log("Pre-building Edge runtime helper image")
    status = run_quietly(
        "Edge helper image build",
        ctx.require_run_dir() / "logs" / "edge-helper-build.log",
        compose_cmd(ctx, "build", "edge"),
        env=ctx.env,
        echo_prefix="[edge-helper] ",
    )
    if status != 0:
        fail(f"Edge helper image build failed with status {status}", status)


def _start_backend(ctx: Ctx) -> None:
    log("Starting backend")
    # Captured like the dependency services: the Edge binary download may
    # still be repainting the progress line when this runs on a cold cache.
    _compose_up(ctx, "Backend service", "[backend] ", "backend")
    _wait_for_backend(ctx)


def _start_edge(ctx: Ctx) -> None:
    log("Starting Edge")
    compose(ctx, "up", "-d", "edge")
    _wait_for_edge(ctx)


def _run_migrations(ctx: Ctx) -> None:
    log("Running backend migrations")
    status = run_quietly(
        "Backend migrations",
        ctx.require_run_dir() / "logs" / "backend-migrate.log",
        [
            "docker",
            "run",
            "--rm",
            "--network",
            f"{ctx.get('COMPOSE_PROJECT_NAME')}_default",
            "-e",
            "AWS_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/wapm",
            "-e",
            "DATABASE_URL=postgresql://postgres:postgres@postgres:5432/wapm",
            "-e",
            "RUST_LOG=info",
            "--entrypoint",
            "/app/smbe",
            ctx.get("BACKEND_IMAGE_REF"),
            "db",
            "migrate",
            "up",
        ],
        env=ctx.env,
        timeout=ctx.getint("LOCAL_PLATFORM_MIGRATE_TIMEOUT_SECONDS", 300),
    )
    if status != 0:
        fail(f"Backend migrations failed with status {status}", status)


def _seed_templates(ctx: Ctx) -> None:
    if ctx.truthy("LOCAL_PLATFORM_USE_BACKEND_TEMPLATE_SEEDER"):
        log(
            "Skipping repo-owned template seeding "
            "(LOCAL_PLATFORM_USE_BACKEND_TEMPLATE_SEEDER=1)"
        )
        return
    if not ctx.truthy("LOCAL_PLATFORM_SEED_TEMPLATES", "1"):
        log(
            "Skipping app template seeding because LOCAL_PLATFORM_SEED_TEMPLATES="
            f"{ctx.get('LOCAL_PLATFORM_SEED_TEMPLATES')}"
        )
        return
    log("Seeding app templates into local registry")
    status = run_quietly(
        "Template seeding",
        ctx.require_run_dir() / "logs" / "template-seed.log",
        [
            "node",
            str(ctx.repo_dir / "local-platform" / "scripts" / "seed-app-templates.mjs"),
            str(ctx.repo_dir),
            str(ctx.require_run_dir()),
        ],
        env=ctx.env,
        echo_prefix="[templates] ",
    )
    if status != 0:
        fail(f"Template seeding failed with status {status}", status)


def _seed_packages(ctx: Ctx) -> None:
    if not ctx.truthy("LOCAL_PLATFORM_SEED_PACKAGES", "1"):
        log(
            "Skipping package dependency seeding because LOCAL_PLATFORM_SEED_PACKAGES="
            f"{ctx.get('LOCAL_PLATFORM_SEED_PACKAGES')}"
        )
        return
    log("Seeding package dependencies into local registry")
    status = run_quietly(
        "Package seeding",
        ctx.require_run_dir() / "logs" / "package-seed.log",
        [
            "node",
            str(ctx.repo_dir / "local-platform" / "scripts" / "seed-packages.mjs"),
            str(ctx.repo_dir),
            str(ctx.require_run_dir()),
        ],
        env={**ctx.env, **read_test_env(ctx, required=True)},
        echo_prefix="[packages] ",
    )
    if status != 0:
        fail(f"Package seeding failed with status {status}", status)


def _persist_relay_queries(ctx: Ctx) -> None:
    log("Persisting Relay queries (if any)")
    status = run_quietly(
        "Relay query persistence",
        ctx.require_run_dir() / "logs" / "persist-relay-queries.log",
        [
            "node",
            str(
                ctx.repo_dir
                / "local-platform"
                / "scripts"
                / "persist-relay-queries.mjs"
            ),
            str(ctx.require_run_dir() / "artifacts" / "relay-persisted-queries.json"),
            f"http://localhost:{ctx.get('BACKEND_HTTP_PORT')}/graphql/persist",
        ],
        env=ctx.env,
        echo_prefix="[relay] ",
    )
    if status != 0:
        fail(f"Relay query persistence failed with status {status}", status)


def _cleanup_failed_up(ctx: Ctx, exit_code: int) -> None:
    ctx.write_timings()
    stop_log_follower(ctx)
    if (ctx.require_run_dir() / "resolved.env").is_file():
        try:
            collect_logs(ctx)
        except Exception as error:
            log_warn(f"Log collection failed: {error}")
        if ctx.truthy("LOCAL_PLATFORM_KEEP_RUNNING_ON_FAILURE") or not ctx.truthy(
            "LOCAL_PLATFORM_AUTO_DOWN", "0"
        ):
            log_warn(
                "Leaving Compose project "
                f"{ctx.get('COMPOSE_PROJECT_NAME')} running for inspection"
            )
        else:
            try:
                down(ctx, skip_collect=True)
            except Exception as error:
                log_warn(f"Teardown failed: {error}")
    log(
        f"local-platform-up failed with status {exit_code}; "
        f"run retained at {ctx.require_run_dir()}"
    )


def up(ctx: Ctx) -> None:
    """Bring the local platform up (idempotently). On success the stack is
    running, `.local-platform/current` points at the run, and ctx carries the
    resolved configuration."""
    require_cmd("docker")
    require_cmd("node")

    load_local_env(ctx)

    if not ctx.is_ci():
        # Treat empty as unset, like `${BACKEND_VERSION:-resolve_prod}` did.
        if not ctx.get("BACKEND_VERSION"):
            ctx.env["BACKEND_VERSION"] = "resolve_prod"
        if not ctx.get("EDGE_VERSION"):
            ctx.env["EDGE_VERSION"] = "resolve_prod"
    if not ctx.get("BACKEND_VERSION"):
        fail("BACKEND_VERSION is required")
    if not ctx.get("EDGE_VERSION"):
        fail("EDGE_VERSION is required")
    ctx.set_default_ports()
    ctx.package_cache_dir()
    ctx.edge_cache_dir()

    if reuse_existing_run_if_running(ctx):
        return

    check_required_ports_available(ctx)
    _create_run_dir(ctx)
    run_dir = ctx.require_run_dir()

    log(f"Run directory: {run_dir}")
    log(
        f"Requested versions: backend={ctx.get('BACKEND_VERSION')} "
        f"edge={ctx.get('EDGE_VERSION')}"
    )

    if _needs_github_token(ctx):
        ensure_github_token(ctx)

    if ctx.truthy("LOCAL_PLATFORM_ARTIFACT_FETCH_PAT_PRESENT"):
        log("Custom artifact fetch PAT is present for private artifact/release fetches")
    elif ctx.get("GH_TOKEN") or ctx.get("GITHUB_TOKEN"):
        log("GitHub token is available for artifact/release fetches")
    else:
        log_warn(
            "No GitHub token is available; private artifact/release fetches may fail"
        )

    try:
        _boot(ctx)
    except BaseException as error:
        if isinstance(error, KeyboardInterrupt):
            exit_code = 130
        elif isinstance(error, Fail):
            exit_code = error.code
        else:
            exit_code = 1
        try:
            _cleanup_failed_up(ctx, exit_code)
        except Exception as cleanup_error:
            log_warn(f"Cleanup after failure itself failed: {cleanup_error}")
        raise

    print_access_summary(ctx)


def _boot(ctx: Ctx) -> None:
    """Fresh-boot pipeline. Independent steps run concurrently:

        resolve ─┬─ fetch backend image ─┬─ migrations ─ bootstrap ─ templates ─ backend ─┬─ packages ─┬─ precompile ─ edge
                 ├─ dependency services ─┘                                                └─ relay ────┤
                 ├─ fetch edge binary ─────────────────────────────────────────────────────(barrier)───┤
                 └─ edge helper build ──────────────────────────────────────────────────────────────────┘
    """
    boot_started = time.monotonic()

    log("Resolving concrete Backend/Edge versions")
    _step(ctx, "resolve", lambda: resolve_mod.resolve(ctx))
    log(
        f"Resolved versions: backend_image_ref={ctx.get('BACKEND_IMAGE_REF')} "
        f"backend_image_source={ctx.get('BACKEND_IMAGE_SOURCE') or '<registry-pull>'} "
        f"edge={ctx.get('EDGE_RESOLVED')}"
    )

    fetch_mod.write_relay_manifest(ctx)
    # Interactive logins must happen before anything runs concurrently.
    fetch_mod.preflight_backend_registry(ctx)

    log("Fetching artifacts and starting dependency services (in parallel)")
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="boot") as pool:
        futures: dict[str, Future] = {
            "backend-image": pool.submit(
                _step, ctx, "fetch-backend-image", lambda: fetch_mod.fetch_backend_image(ctx)
            ),
            "edge-binary": pool.submit(
                _step, ctx, "fetch-edge-binary", lambda: fetch_mod.fetch_edge_binary(ctx)
            ),
            "dependencies": pool.submit(
                _step, ctx, "dependency-services", lambda: _start_dependency_services(ctx)
            ),
        }
        if ctx.truthy("LOCAL_PLATFORM_ENSURE_COMPILED", "1"):
            futures["edge-helper-build"] = pool.submit(
                _step, ctx, "edge-helper-build", lambda: _build_edge_helper(ctx)
            )
        try:
            _await_steps(futures, "backend-image", "dependencies")
            _step(ctx, "migrations", lambda: _run_migrations(ctx))
            _step(ctx, "bootstrap", lambda: bootstrap_mod.bootstrap(ctx))

            # Repo-owned template seeding (bootstrap passes --skip-templates
            # to the backend's embedded seeder). Kept strictly before the
            # backend start, like the original flow: the backend may read
            # templates as it comes up. Package seeding and Relay persistence
            # both need the running backend and overlap with each other.
            _step(ctx, "template-seeding", lambda: _seed_templates(ctx))
            _step(ctx, "backend-start", lambda: _start_backend(ctx))
            futures["packages"] = pool.submit(
                _step, ctx, "package-seeding", lambda: _seed_packages(ctx)
            )
            futures["relay"] = pool.submit(
                _step, ctx, "relay-persistence", lambda: _persist_relay_queries(ctx)
            )

            # Precompilation needs everything that is still in flight: the
            # Edge binary + helper image, and the package-seed diagnostics.
            _await_steps(futures, *list(futures.keys()))
            _step(ctx, "precompile", lambda: ensure_compiled_mod.ensure_compiled(ctx))
            _step(ctx, "edge-start", lambda: _start_edge(ctx))
        except BaseException:
            _drain_remaining(futures)
            raise

    total = time.monotonic() - boot_started
    ctx.record_timing("total", total)
    ctx.write_timings()
    slowest = sorted(
        (t for t in ctx.timings if t["step"] != "total"),
        key=lambda t: float(t["seconds"]),  # type: ignore[arg-type]
        reverse=True,
    )[:3]
    breakdown = ", ".join(f"{t['step']} {t['seconds']}s" for t in slowest)
    log(f"Local platform ready in {total:.1f}s (slowest steps: {breakdown})")
