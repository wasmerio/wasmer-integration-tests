"""`status`: read-only snapshot of the current local platform run."""

from __future__ import annotations

import urllib.error
import urllib.request

import sys

from .lib import (
    ANSI_GREEN,
    ANSI_RED,
    ANSI_RESET,
    ANSI_YELLOW,
    Ctx,
    describe_backend_version,
    describe_edge_version,
    try_output,
    use_color,
)


def _probe(url: str) -> tuple[int | None, str]:
    """One HTTP attempt: (status, detail). Any status below 500 counts as
    serving (Edge's root 400s by design). Bypasses proxies like wait_url."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=3) as response:
            return response.status, ""
    except urllib.error.HTTPError as error:
        return error.code, ""
    except Exception as error:
        return None, str(error)


def _paint(text: str, color: str) -> str:
    # Gate on stdout (where status prints), not the logger's stderr: piping
    # or redirecting `status` output must yield ANSI-free text.
    if not use_color(sys.stdout):
        return text
    return f"{color}{text}{ANSI_RESET}"


def status(ctx: Ctx) -> int:
    """Print the current run's state. Exit 0 when backend and Edge both
    serve HTTP, 1 otherwise (including when no run exists)."""
    # Honor a preset run dir (RUN_DIR override via the CLI), falling back to
    # the current symlink like down/logs do.
    if ctx.run_dir is None:
        current = ctx.current_run_dir()
        if current is None:
            print("No current local platform run (.local-platform/current missing).")
            print("Start one with: make local-platform-up")
            return 1
        ctx.run_dir = current
    run_dir = ctx.require_run_dir()
    ctx.load_resolved_env()

    print(f"Run directory:   {run_dir}")
    print(
        f"Selectors:       backend={ctx.get('BACKEND_VERSION')} "
        f"edge={ctx.get('EDGE_VERSION')}"
    )
    print(f"Compose project: {ctx.get('COMPOSE_PROJECT_NAME')}")

    containers = try_output(
        [
            "docker",
            "ps",
            "--all",
            "--filter",
            f"label=com.docker.compose.project={ctx.get('COMPOSE_PROJECT_NAME')}",
            "--format",
            '{{.Label "com.docker.compose.service"}}\t{{.State}}\t{{.Status}}\t{{.Image}}',
        ],
        env=ctx.env,
    )
    running_images: dict[str, str] = {}
    service_rows: list[tuple[str, str, str]] = []
    for line in sorted(containers.splitlines()):
        service, _, rest = line.partition("\t")
        state, _, rest = rest.partition("\t")
        detail, _, image = rest.partition("\t")
        service_rows.append((service, state, detail))
        if state == "running":
            running_images[service] = image

    print("\nVersions:")
    print(f"  Backend  {describe_backend_version(ctx)}")
    backend_running = running_images.get("backend", "")
    if backend_running and backend_running != ctx.get("BACKEND_IMAGE_REF"):
        print(
            _paint(
                f"           running container uses a different image: "
                f"{backend_running}",
                ANSI_YELLOW,
            )
        )
    print(f"  Edge     {describe_edge_version(ctx)}")

    print("\nServices:")
    if service_rows:
        for service, state, detail in service_rows:
            color = ANSI_GREEN if state == "running" else ANSI_RED
            print(f"  {service:<24} {_paint(f'{state:<10}', color)} {detail}")
    else:
        print(_paint("  no containers (stack is down)", ANSI_YELLOW))

    backend_url = f"http://localhost:{ctx.get('BACKEND_HTTP_PORT')}/graphql"
    edge_url = f"http://127.0.0.1:{ctx.get('EDGE_HTTP_PORT')}/"
    print("\nEndpoints:")
    all_serving = True
    for name, url in (("Backend", backend_url), ("Edge", edge_url)):
        http_status, detail = _probe(url)
        if http_status is not None and http_status < 500:
            print(f"  {name:<8} {url:<42} {_paint(f'serving ({http_status})', ANSI_GREEN)}")
        else:
            all_serving = False
            shown = f"HTTP {http_status}" if http_status is not None else detail
            print(f"  {name:<8} {url:<42} {_paint(f'unreachable: {shown}', ANSI_RED)}")

    print(
        f"\nLoad test env:   source {run_dir}/test-env.sh"
        f"\nFollow logs:     make local-platform-logs"
        f"\nTear down:       make local-platform-down"
    )
    return 0 if all_serving else 1
