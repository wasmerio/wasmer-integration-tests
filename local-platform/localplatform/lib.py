"""Shared runtime for the local platform tooling: context, logging, env files,
subprocess helpers, port checks, and docker compose invocation."""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path

DEFAULT_TEST_COMMAND = "pnpm exec jest"

ANSI_RESET = "\033[0m"
ANSI_DIM_GRAY = "\033[90m"
ANSI_CYAN = "\033[36m"
ANSI_GREEN = "\033[32m"
ANSI_YELLOW = "\033[33m"
ANSI_RED = "\033[31m"
ANSI_BOLD = "\033[1m"
ANSI_BOLD_RED = "\033[1;31m"

CLEAR_LINE = "\r\033[K"

LEVEL_COLORS = {
    "DEBUG": ANSI_CYAN,
    "INFO": ANSI_GREEN,
    "WARNING": ANSI_YELLOW,
    "ERROR": ANSI_RED,
    "CRITICAL": ANSI_BOLD_RED,
}

# Host ports the disposable stack binds, with their defaults and the service
# label used in availability errors. EDGE_DNS_PORT is UDP, so it is exempt
# from the TCP availability check.
PORT_DEFAULTS: dict[str, tuple[int, str]] = {
    "BACKEND_HTTP_PORT": (18000, "Backend HTTP"),
    "EDGE_HTTP_PORT": (19080, "Edge HTTP"),
    "EDGE_HTTPS_PORT": (19443, "Edge HTTPS"),
    "EDGE_NODE_API_PORT": (19050, "Edge Node API"),
    "EDGE_GRPC_PORT": (19051, "Edge gRPC"),
    "EDGE_SSH_PORT": (19022, "Edge SSH/SFTP"),
    "EDGE_DNS_PORT": (19053, "Edge DNS"),
    "POSTGRES_PORT": (15432, "Postgres"),
    "REDIS_PORT": (16379, "Redis"),
    "MYSQL_APP_DB_1_PORT": (13306, "MySQL app DB 1"),
    "MYSQL_APP_DB_2_PORT": (13307, "MySQL app DB 2"),
    "MINIO_PERSISTENT_API_PORT": (19100, "MinIO persistent API"),
    "MINIO_PERSISTENT_CONSOLE_PORT": (19101, "MinIO persistent console"),
    "CLICKHOUSE_HTTP_PORT": (18123, "ClickHouse HTTP"),
    "CLICKHOUSE_NATIVE_PORT": (19123, "ClickHouse native"),
    "LOKI_PORT": (13100, "Loki"),
    "VECTOR_HTTP_PORT": (19089, "Vector HTTP"),
}
UDP_PORT_VARS = frozenset({"EDGE_DNS_PORT"})

# Keys resolve() records into resolved.env / resolved.json.
RESOLVED_ENV_KEYS = (
    "BACKEND_VERSION",
    "EDGE_VERSION",
    "BACKEND_IMAGE_REF",
    "BACKEND_IMAGE_SOURCE",
    "EDGE_RESOLVED",
    "LOCAL_TEST_COMMAND",
    "COMPOSE_PROJECT_NAME",
    "DOCKER_CLI_PATH",
    "DOCKER_BUILDX_PATH",
    *PORT_DEFAULTS.keys(),
)


class Fail(Exception):
    """Fatal, user-facing error. The CLI logs it and exits with `code`."""

    def __init__(self, message: str, code: int = 1):
        super().__init__(message)
        self.code = code


def fail(message: str, code: int = 1) -> "NoReturn":  # noqa: F821
    raise Fail(message, code)


def is_truthy(value: str | None) -> bool:
    return (value or "").strip().lower() not in ("", "0", "false", "no", "off")


class Ctx:
    """One tooling invocation: repo paths plus the effective environment.

    `env` mirrors what the bash scripts kept as exported shell variables: it
    starts as a copy of os.environ, `local.env` is layered on top by up(), and
    resolve() adds the resolved configuration. Every subprocess we spawn
    receives this mapping, so docker compose interpolation and helper scripts
    see exactly what the previous implementation exported.
    """

    def __init__(self, env: Mapping[str, str] | None = None):
        self.repo_dir = Path(
            os.environ.get("REPO_DIR") or Path(__file__).resolve().parents[2]
        )
        self.local_platform_dir = self.repo_dir / ".local-platform"
        self.compose_file = self.repo_dir / "docker-compose.local-platform.yaml"
        self.env: dict[str, str] = dict(env if env is not None else os.environ)
        self.run_dir: Path | None = None
        self.timings: list[dict[str, object]] = []
        self._timings_lock = threading.Lock()

    def record_timing(self, step: str, seconds: float) -> None:
        with self._timings_lock:
            self.timings.append({"step": step, "seconds": round(seconds, 2)})

    def write_timings(self) -> None:
        """Persist per-step boot timings for performance archaeology in CI."""
        if self.run_dir is None or not self.timings:
            return
        try:
            diagnostics = self.run_dir / "diagnostics"
            diagnostics.mkdir(parents=True, exist_ok=True)
            with self._timings_lock:
                (diagnostics / "timings.json").write_text(
                    json.dumps(self.timings, indent=2) + "\n"
                )
        except OSError:
            pass

    # -- config accessors ---------------------------------------------------

    def get(self, name: str, default: str = "") -> str:
        return self.env.get(name, default)

    def getint(self, name: str, default: int) -> int:
        raw = self.env.get(name, "")
        try:
            return int(raw)
        except ValueError:
            return default

    def truthy(self, name: str, default: str = "") -> bool:
        # `or default` mirrors bash `${VAR:-default}`: a set-but-empty
        # variable falls back to the default, it does not read as false.
        return is_truthy(self.env.get(name) or default)

    def is_ci(self) -> bool:
        return self.get("CI") == "true" or bool(self.get("GITHUB_ACTIONS"))

    # -- standard directories ----------------------------------------------

    def default_env(self, name: str, default: str) -> str:
        """Bash `: "${VAR:=default}"` semantics: set-but-empty counts as
        unset, so an empty override never leaks into compose interpolation or
        generated env files."""
        if not self.env.get(name):
            self.env[name] = default
        return self.env[name]

    def package_cache_dir(self) -> Path:
        return Path(
            self.default_env(
                "LOCAL_PLATFORM_PACKAGE_CACHE_DIR",
                str(self.local_platform_dir / "package-cache"),
            )
        )

    def edge_cache_dir(self) -> Path:
        return Path(
            self.default_env(
                "LOCAL_PLATFORM_EDGE_CACHE_DIR",
                str(self.local_platform_dir / "cache" / "edge"),
            )
        )

    def set_default_ports(self) -> None:
        for var, (default, _service) in PORT_DEFAULTS.items():
            self.default_env(var, str(default))

    def require_run_dir(self) -> Path:
        if self.run_dir is None:
            fail("RUN_DIR is not set")
        return self.run_dir

    def current_run_dir(self) -> Path | None:
        """The real directory behind .local-platform/current, if it exists."""
        current = self.local_platform_dir / "current"
        if current.is_dir():
            return current.resolve()
        return None

    def set_run_dir_env(self) -> None:
        """Expose RUN_DIR to subprocesses (docker compose interpolates it)."""
        self.env["RUN_DIR"] = str(self.require_run_dir())

    # -- resolved run state --------------------------------------------------

    def load_resolved_env(self) -> None:
        """Load a run's recorded configuration, mirroring bash's
        `source resolved.env`: recorded values override the caller env so the
        run's own ports/project name always win for that run."""
        if self.run_dir is None:
            current = self.current_run_dir()
            if current is None:
                fail("RUN_DIR is not set and .local-platform/current does not exist")
            self.run_dir = current
        resolved_env = self.require_run_dir() / "resolved.env"
        resolved_json = self.require_run_dir() / "resolved.json"
        if resolved_env.is_file():
            self.env.update(parse_env_file(resolved_env))
        elif resolved_json.is_file():
            self.env.update(read_resolved_json(resolved_json))
        else:
            fail(f"Missing resolved env: {resolved_env}")
        self.set_run_dir_env()
        self.edge_cache_dir()
        self.package_cache_dir()


def read_resolved_json(path: Path) -> dict[str, str]:
    """resolved.json is the canonical machine-readable run record; flatten it
    back into the env-var shape the tooling works with."""
    data = json.loads(path.read_text())
    flat: dict[str, str] = {}
    for json_key, env_key in (
        ("backend_version", "BACKEND_VERSION"),
        ("edge_version", "EDGE_VERSION"),
        ("backend_image_ref", "BACKEND_IMAGE_REF"),
        ("backend_image_source", "BACKEND_IMAGE_SOURCE"),
        ("edge_resolved", "EDGE_RESOLVED"),
        ("local_test_command", "LOCAL_TEST_COMMAND"),
        ("compose_project_name", "COMPOSE_PROJECT_NAME"),
        ("docker_cli_path", "DOCKER_CLI_PATH"),
        ("docker_buildx_path", "DOCKER_BUILDX_PATH"),
    ):
        if json_key in data:
            flat[env_key] = str(data[json_key])
    for port_key, value in (data.get("ports") or {}).items():
        # ports JSON keys are the env var names lowercased minus `_PORT`.
        flat[f"{port_key.upper()}_PORT"] = str(value)
    return flat


# ---------------------------------------------------------------------------
# Env-file parsing and writing
# ---------------------------------------------------------------------------

_VAR_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_ANSI_C_ESCAPES = {
    "n": "\n",
    "t": "\t",
    "r": "\r",
    "a": "\a",
    "b": "\b",
    "f": "\f",
    "v": "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
}


class _EnvFileScanner:
    """Quote-aware tokenizer for the shell env files this tooling reads
    (`local.env`, the generated `test-env.sh`, `resolved.env`).

    Follows POSIX shell word rules closely enough for these files: single
    quotes are literal, double quotes and bare words expand `$VAR`/`${VAR}`/
    `${VAR:-default}`, backslash escapes, `$'...'` ANSI-C quoting (bash's
    `printf %q` output, which legacy resolved.env files contain), `#`
    comments, and quoted values spanning lines. Command substitution and
    other shell constructs raise a clear error instead of being silently
    mangled — precompute such values before putting them in local.env.
    """

    def __init__(self, text: str, expand):
        self.text = text
        self.expand = expand  # name -> value
        self.pos = 0

    def tokens(self) -> Iterable[str]:
        text, n = self.text, len(self.text)
        while self.pos < n:
            char = text[self.pos]
            if char in " \t\n":
                self.pos += 1
            elif char == "#":  # comment: only at the start of a word
                while self.pos < n and text[self.pos] != "\n":
                    self.pos += 1
            else:
                yield self._read_word()

    def _read_word(self) -> str:
        text, n = self.text, len(self.text)
        parts: list[str] = []
        while self.pos < n and text[self.pos] not in " \t\n":
            char = text[self.pos]
            if char == "'":
                parts.append(self._read_single_quoted())
            elif char == '"':
                parts.append(self._read_double_quoted())
            elif char == "\\":
                if self.pos + 1 < n:
                    if text[self.pos + 1] != "\n":  # \<newline> = continuation
                        parts.append(text[self.pos + 1])
                    self.pos += 2
                else:
                    self.pos += 1
            elif char == "$":
                if text.startswith("$'", self.pos):
                    self.pos += 1
                    parts.append(self._read_ansi_c_quoted())
                else:
                    parts.append(self._read_expansion())
            elif char == "`":
                raise ValueError(
                    "backtick command substitution is not supported; compute "
                    "the value in your shell and set it literally"
                )
            else:
                parts.append(char)
                self.pos += 1
        return "".join(parts)

    def _read_single_quoted(self) -> str:
        end = self.text.find("'", self.pos + 1)
        if end == -1:
            raise ValueError(f"unterminated single quote at offset {self.pos}")
        value = self.text[self.pos + 1 : end]
        self.pos = end + 1
        return value

    def _read_double_quoted(self) -> str:
        text, n = self.text, len(self.text)
        self.pos += 1
        parts: list[str] = []
        while self.pos < n:
            char = text[self.pos]
            if char == '"':
                self.pos += 1
                return "".join(parts)
            if char == "\\" and self.pos + 1 < n and text[self.pos + 1] in '"\\$`\n':
                if text[self.pos + 1] != "\n":
                    parts.append(text[self.pos + 1])
                self.pos += 2
            elif char == "$":
                parts.append(self._read_expansion())
            elif char == "`":
                raise ValueError(
                    "backtick command substitution is not supported; compute "
                    "the value in your shell and set it literally"
                )
            else:
                parts.append(char)
                self.pos += 1
        raise ValueError(f"unterminated double quote at offset {self.pos}")

    def _read_ansi_c_quoted(self) -> str:
        """$'...' — bash ANSI-C quoting; `printf %q` emits it for newlines."""
        text, n = self.text, len(self.text)
        self.pos += 1  # opening quote
        parts: list[str] = []
        while self.pos < n:
            char = text[self.pos]
            if char == "'":
                self.pos += 1
                return "".join(parts)
            if char == "\\" and self.pos + 1 < n:
                escape = text[self.pos + 1]
                parts.append(_ANSI_C_ESCAPES.get(escape, "\\" + escape))
                self.pos += 2
            else:
                parts.append(char)
                self.pos += 1
        raise ValueError(f"unterminated $'...' quote at offset {self.pos}")

    def _read_expansion(self) -> str:
        text = self.text
        if text.startswith("$(", self.pos):
            raise ValueError(
                "command substitution $(...) is not supported; compute the "
                "value in your shell and set it literally"
            )
        if text.startswith("${", self.pos):
            end = text.find("}", self.pos + 2)
            if end == -1:
                raise ValueError(f"unterminated ${{...}} at offset {self.pos}")
            inner = text[self.pos + 2 : end]
            if _VAR_NAME.fullmatch(inner):
                self.pos = end + 1
                return self.expand(inner)
            default_match = re.fullmatch(
                r"([A-Za-z_][A-Za-z0-9_]*):?-(.*)", inner, re.S
            )
            if default_match:
                name, default = default_match.groups()
                if "$" in default or "`" in default:
                    raise ValueError(
                        f"nested expansion in ${{{inner}}} is not supported"
                    )
                self.pos = end + 1
                return self.expand(name) or default
            raise ValueError(f"unsupported parameter expansion ${{{inner}}}")
        match = _VAR_NAME.match(text, self.pos + 1)
        if match:
            self.pos = match.end()
            return self.expand(match.group(0))
        self.pos += 1
        return "$"


def parse_env_file(
    path: Path, base_env: Mapping[str, str] | None = None
) -> dict[str, str]:
    """Parse a shell-style env file (`export KEY=value`) into a dict.

    `$VAR`/`${VAR}` references in unquoted or double-quoted values are
    expanded against previously parsed entries, then base_env; single-quoted
    values stay literal, exactly like `source` would treat them.
    """
    result: dict[str, str] = {}
    lookup: Mapping[str, str] = base_env or {}

    def expand(name: str) -> str:
        if name in result:
            return result[name]
        return lookup.get(name, "")

    try:
        # Consume tokens as they stream so `$FOO` in a later assignment sees
        # earlier assignments from the same file, like sequential sourcing.
        for token in _EnvFileScanner(path.read_text(), expand).tokens():
            name, sep, value = token.partition("=")
            if sep and _VAR_NAME.fullmatch(name):
                result[name] = value
    except ValueError as error:
        fail(f"Failed to parse {path}: {error}")
    return result


def write_env_file(path: Path, values: Mapping[str, str]) -> None:
    lines = [f"export {name}={shlex.quote(value)}" for name, value in values.items()]
    path.write_text("\n".join(lines) + "\n")


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

_progress_line_active = False
_log_lock = threading.Lock()

# Logging switches read os.environ dynamically (not snapshotted at import):
# up() propagates VERBOSE/NO_COLOR/LOCAL_PLATFORM_DISABLE_INLINE_PROGRESS from
# local.env into os.environ, matching bash's `set -a; source local.env`.


def use_color(stream) -> bool:
    return stream.isatty() and not os.environ.get("NO_COLOR")


def log_use_color() -> bool:
    return use_color(sys.stderr)


def log_is_verbose() -> bool:
    return is_truthy(os.environ.get("VERBOSE"))


def log_progress_enabled() -> bool:
    return (
        not log_is_verbose()
        and sys.stderr.isatty()
        and not is_truthy(
            os.environ.get("LOCAL_PLATFORM_DISABLE_INLINE_PROGRESS") or "0"
        )
    )


def log_clear() -> None:
    global _progress_line_active
    with _log_lock:
        if log_progress_enabled() and _progress_line_active:
            sys.stderr.write(CLEAR_LINE)
            sys.stderr.flush()
            _progress_line_active = False


def _terminal_width() -> int:
    return shutil.get_terminal_size(fallback=(120, 24)).columns


def _render_progress_line(text: str) -> None:
    """Paint the shared single-line progress display. Caller must hold
    _log_lock; sets _progress_line_active so the next full log line clears
    this one first."""
    global _progress_line_active
    rendered = text[: max(_terminal_width() - 1, 1)]
    if log_use_color():
        rendered = f"{ANSI_DIM_GRAY}{rendered}{ANSI_RESET}"
    sys.stderr.write(f"{CLEAR_LINE}{rendered}")
    sys.stderr.flush()
    _progress_line_active = True


def log_emit(level: str, message: str) -> None:
    global _progress_line_active
    if level == "DEBUG" and not log_is_verbose():
        return

    with _log_lock:
        if log_progress_enabled() and level in ("INFO", "DEBUG"):
            _render_progress_line(f"[local-platform] {message}")
            return

        prefix = CLEAR_LINE if log_progress_enabled() and _progress_line_active else ""
        _progress_line_active = False
        timestamp = time.strftime("%H:%M:%S")
        rendered_level = f"{level:<7}"
        color = LEVEL_COLORS.get(level, "") if log_use_color() else ""
        if color:
            rendered_level = f"{color}{rendered_level}{ANSI_RESET}"
        sys.stderr.write(f"{prefix}{timestamp} {rendered_level} {message}\n")
        sys.stderr.flush()


def log(message: str) -> None:
    log_emit("INFO", message)


def log_debug(message: str) -> None:
    log_emit("DEBUG", message)


def log_warn(message: str) -> None:
    log_emit("WARNING", message)


def human_bytes(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(value) < 1024 or unit == "TB":
            if unit == "B":
                return f"{int(value)}{unit}"
            return f"{value:.1f}{unit}"
        value /= 1024
    return f"{int(size)}B"


def format_duration(ms: float) -> str:
    total_seconds = max(0, int(ms // 1000))
    return f"{total_seconds // 60}m{total_seconds % 60:02d}s"


class DownloadProgress:
    """Background thread that renders an inline `Downloading <label> ...` line
    with size/rate while a file or directory grows. Participates in the shared
    single-line progress protocol (lock + active flag), so concurrent log
    lines from other boot steps clear it instead of splicing into it.
    Inline-progress mode only: in CI logs the per-step log lines are enough."""

    def __init__(self, label: str, path: Path):
        self.label = label
        self.path = path
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def __enter__(self) -> "DownloadProgress":
        if log_progress_enabled():
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
            log_clear()

    def _current_size(self) -> int:
        try:
            if self.path.is_dir():
                return sum(
                    entry.stat().st_size
                    for entry in self.path.rglob("*")
                    if entry.is_file()
                )
            if self.path.exists():
                return self.path.stat().st_size
        except OSError:
            pass
        return 0

    def _run(self) -> None:
        started = time.monotonic()
        last_time, last_size = started, 0
        while not self._stop.wait(2):
            size = self._current_size()
            now = time.monotonic()
            rate = int((size - last_size) / max(now - last_time, 1e-9))
            with _log_lock:
                _render_progress_line(
                    f"Downloading {self.label} "
                    f"({human_bytes(size)}, {human_bytes(rate)}/s, "
                    f"{int(now - started)}s elapsed)"
                )
            last_time, last_size = now, size


# ---------------------------------------------------------------------------
# Subprocess helpers
# ---------------------------------------------------------------------------


def require_cmd(name: str) -> str:
    path = shutil.which(name)
    if not path:
        fail(f"Missing required command: {name}")
    return path


def run(
    cmd: Sequence[str],
    *,
    env: Mapping[str, str],
    check: bool = True,
    capture: bool = False,
    input_bytes: bytes | None = None,
    timeout: float | None = None,
    cwd: Path | None = None,
    stdout: int | None = None,
    stderr: int | None = None,
) -> subprocess.CompletedProcess[bytes]:
    """Thin subprocess.run wrapper; commands inherit stdio unless captured."""
    try:
        result = subprocess.run(
            list(cmd),
            env=dict(env),
            input=input_bytes,
            stdout=subprocess.PIPE if capture else stdout,
            stderr=subprocess.PIPE if capture else stderr,
            timeout=timeout,
            cwd=cwd,
        )
    except subprocess.TimeoutExpired:
        fail(f"Command timed out after {timeout}s: {shlex.join(cmd)}", 124)
    except FileNotFoundError:
        fail(f"Missing required command: {cmd[0]}")
    if check and result.returncode != 0:
        detail = ""
        if capture and result.stderr:
            detail = ": " + result.stderr.decode(errors="replace").strip()[-2000:]
        fail(
            f"Command failed with status {result.returncode}: "
            f"{shlex.join(cmd)}{detail}",
            result.returncode,
        )
    return result


def run_output(
    cmd: Sequence[str],
    *,
    env: Mapping[str, str],
    check: bool = True,
    timeout: float | None = None,
) -> str:
    """Run and return stripped stdout; stderr is captured into the failure."""
    return (
        run(cmd, env=env, check=check, capture=True, timeout=timeout)
        .stdout.decode(errors="replace")
        .strip()
    )


def try_output(
    cmd: Sequence[str], *, env: Mapping[str, str], timeout: float | None = 60
) -> str:
    """Best-effort stdout: empty string on any failure (missing binary,
    non-zero exit, timeout). Mirrors bash's `$(cmd 2>/dev/null || true)`."""
    try:
        result = subprocess.run(
            list(cmd),
            env=dict(env),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if result.returncode != 0:
        return ""
    return result.stdout.decode(errors="replace").strip()


class _LinePrefixer:
    """Wraps a byte stream, prefixing every complete line. Used when several
    boot steps stream concurrently (CI logs), so their lines stay attributable
    instead of interleaving anonymously. Writes whole lines only, which also
    keeps concurrent writers from splicing into each other mid-line."""

    def __init__(self, stream, prefix: str):
        self._stream = stream
        self._prefix = prefix.encode()
        self._pending = b""

    def write(self, chunk: bytes) -> None:
        self._pending += chunk
        *lines, self._pending = self._pending.split(b"\n")
        for line in lines:
            self._stream.write(self._prefix + line + b"\n")

    def flush(self) -> None:
        self._stream.flush()

    def finish(self) -> None:
        if self._pending:
            self._stream.write(self._prefix + self._pending + b"\n")
            self._pending = b""
        self._stream.flush()


def _stream_process(
    process: subprocess.Popen[bytes],
    log_handle,
    echo_stream,
    timeout: float | None,
) -> int:
    """Pump combined output from `process` into log_handle (and optionally an
    echo stream), enforcing `timeout` on the whole process group."""
    timed_out = threading.Event()

    def on_timeout() -> None:
        timed_out.set()
        _kill_process_group(process)

    timer = threading.Timer(timeout, on_timeout) if timeout else None
    if timer:
        timer.start()
    try:
        assert process.stdout is not None
        while chunk := process.stdout.read1(65536):
            log_handle.write(chunk)
            log_handle.flush()
            if echo_stream is not None:
                echo_stream.write(chunk)
                echo_stream.flush()
        process.wait()
    except BaseException:
        # Children run in their own session and never see the terminal's
        # SIGINT; on Ctrl-C (or any error here) take the whole group down
        # before propagating, like a foreground bash child would have died.
        _kill_process_group(process)
        raise
    finally:
        if timer:
            timer.cancel()
        if isinstance(echo_stream, _LinePrefixer):
            echo_stream.finish()
    return 124 if timed_out.is_set() else process.returncode


def _kill_process_group(process: subprocess.Popen[bytes]) -> None:
    """TERM, then after a grace period KILL, the whole process group.

    The final SIGKILL is sent even when the direct child already exited: a
    TERM-ignoring grandchild would otherwise keep the shared output pipe open
    and block the reader forever."""
    import signal

    try:
        pgid = os.getpgid(process.pid)
    except ProcessLookupError:
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(50):
        if process.poll() is not None:
            break
        time.sleep(0.1)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def run_streaming(
    cmd: Sequence[str],
    log_file: Path,
    *,
    env: Mapping[str, str],
    cwd: Path | None = None,
    timeout: float | None = None,
    echo_prefix: str | None = None,
) -> int:
    """Run `cmd`, teeing combined stdout+stderr to log_file and our stdout.
    `echo_prefix` labels each echoed line (log_file stays unprefixed)."""
    log_file.parent.mkdir(parents=True, exist_ok=True)
    echo = sys.stdout.buffer
    if echo_prefix is not None:
        echo = _LinePrefixer(echo, echo_prefix)
    with open(log_file, "wb") as log_handle:
        process = subprocess.Popen(
            list(cmd),
            env=dict(env),
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        return _stream_process(process, log_handle, echo, timeout)


def run_quietly(
    label: str,
    log_file: Path,
    cmd: Sequence[str],
    *,
    env: Mapping[str, str],
    cwd: Path | None = None,
    timeout: float | None = None,
    print_output_on_failure: bool = True,
    echo_prefix: str | None = None,
) -> int:
    """Run a step whose output only matters on failure.

    Verbose runs and non-TTY runs (CI logs) stream the output live while still
    capturing it to log_file; interactive runs capture quietly and dump the
    log only if the step fails. Returns the exit status (124 on timeout).
    """
    log_file.parent.mkdir(parents=True, exist_ok=True)

    if log_is_verbose() or not sys.stderr.isatty():
        return run_streaming(
            cmd, log_file, env=env, cwd=cwd, timeout=timeout, echo_prefix=echo_prefix
        )

    with open(log_file, "wb") as log_handle:
        process = subprocess.Popen(
            list(cmd),
            env=dict(env),
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        status = _stream_process(process, log_handle, None, timeout)

    if status != 0:
        log_clear()
        log_warn(f"{label} failed; showing captured output from {log_file}")
        if print_output_on_failure:
            try:
                sys.stderr.buffer.write(log_file.read_bytes())
                sys.stderr.flush()
            except OSError:
                pass
        return status

    log(f"{label} complete")
    return 0


def run_in_pty(
    cmd: Sequence[str], log_file: Path, *, env: Mapping[str, str]
) -> int:
    """Run `cmd` under a pseudo-terminal, capturing output to log_file.

    gh only emits its download progress/diagnostics when it believes it has a
    terminal; the previous implementation used script(1) for this. A PTY here
    also preserves the real exit status, which script(1) swallowed.
    """
    import pty

    log_file.parent.mkdir(parents=True, exist_ok=True)
    master, slave = pty.openpty()
    try:
        process = subprocess.Popen(
            list(cmd),
            env=dict(env),
            stdin=subprocess.DEVNULL,
            stdout=slave,
            stderr=slave,
            close_fds=True,
        )
    finally:
        os.close(slave)
    with open(log_file, "wb") as log_handle:
        while True:
            try:
                data = os.read(master, 65536)
            except OSError:  # EIO once the child closes the slave end
                break
            if not data:
                break
            log_handle.write(data)
    os.close(master)
    return process.wait()


def process_is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


# ---------------------------------------------------------------------------
# Ports
# ---------------------------------------------------------------------------


def port_is_listening(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(1)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def port_owner_hint(ctx: Ctx, port: int) -> str:
    """Best-effort description of what is holding a port (lsof/ss/docker)."""
    hints: list[str] = []
    if shutil.which("lsof"):
        output = try_output(
            ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"], env=ctx.env
        )
        hints.extend(output.splitlines()[1:4])
    elif shutil.which("ss"):
        output = try_output(["ss", "-ltnp"], env=ctx.env)
        pattern = re.compile(rf"[:.]{port}\s")
        hints.extend(
            [line for line in output.splitlines() if pattern.search(line)][:3]
        )
    if shutil.which("docker"):
        output = try_output(
            ["docker", "ps", "--format", "{{.ID}} {{.Names}} {{.Ports}}"], env=ctx.env
        )
        pattern = re.compile(rf"(^|[^0-9]){port}([^0-9]|$)")
        hints.extend(
            [line for line in output.splitlines() if pattern.search(line)][:3]
        )
    return "\n".join(hints)


def check_required_ports_available(ctx: Ctx) -> None:
    ctx.set_default_ports()
    for var, (_default, service) in PORT_DEFAULTS.items():
        if var in UDP_PORT_VARS:
            continue
        port = ctx.getint(var, PORT_DEFAULTS[var][0])
        if port_is_listening(port):
            owner = port_owner_hint(ctx, port)
            if owner:
                log_warn(f"Port {port} for {service} is already in use:")
                print(owner, file=sys.stderr)
            fail(
                f"Port {port} for {service} is already allocated. Stop the "
                f"process using it or rerun with {var}=<free-port>."
            )


# ---------------------------------------------------------------------------
# GitHub token / docker compose
# ---------------------------------------------------------------------------


def ensure_github_token(ctx: Ctx) -> None:
    if ctx.get("GH_TOKEN"):
        return
    if ctx.get("GITHUB_TOKEN"):
        ctx.env["GH_TOKEN"] = ctx.get("GITHUB_TOKEN")
        return
    if not shutil.which("gh"):
        fail(
            "GH_TOKEN is not set, GITHUB_TOKEN is not set, and GitHub CLI "
            "is not installed"
        )
    token = try_output(["gh", "auth", "token"], env=ctx.env)
    if not token:
        fail("GH_TOKEN is not set and could not be resolved via 'gh auth token'")
    ctx.env["GH_TOKEN"] = token


def compose_cmd(ctx: Ctx, *args: str) -> list[str]:
    project = ctx.get("COMPOSE_PROJECT_NAME")
    if not project:
        fail("COMPOSE_PROJECT_NAME is required")
    return [
        "docker",
        "compose",
        "--project-name",
        project,
        "--file",
        str(ctx.compose_file),
        *args,
    ]


def compose(ctx: Ctx, *args: str, **kwargs) -> subprocess.CompletedProcess[bytes]:
    return run(compose_cmd(ctx, *args), env=ctx.env, **kwargs)


def compose_project_has_running_containers(ctx: Ctx) -> bool:
    project = ctx.get("COMPOSE_PROJECT_NAME")
    if not project:
        fail("COMPOSE_PROJECT_NAME is required")
    output = try_output(
        [
            "docker",
            "ps",
            "--filter",
            f"label=com.docker.compose.project={project}",
            "--format",
            "{{.Names}}",
        ],
        env=ctx.env,
    )
    return bool(output.strip())


def compose_service_is_running(ctx: Ctx, service: str) -> bool:
    project = ctx.get("COMPOSE_PROJECT_NAME")
    if not project:
        fail("COMPOSE_PROJECT_NAME is required")
    output = try_output(
        [
            "docker",
            "ps",
            "--filter",
            f"label=com.docker.compose.project={project}",
            "--filter",
            f"label=com.docker.compose.service={service}",
            "--format",
            "{{.Names}}",
        ],
        env=ctx.env,
    )
    return bool(output.strip())


# ---------------------------------------------------------------------------
# HTTP readiness polling (replaces wait-url.mjs)
# ---------------------------------------------------------------------------


def wait_url(url: str, timeout_ms: int) -> None:
    """Poll `url` until it serves HTTP (any status below 500) or time out.

    A 4xx still counts as ready: it proves the service is up and routing;
    Edge's root URL for example 404s by design.
    """
    import urllib.error
    import urllib.request

    # Only ever polls loopback URLs: bypass http_proxy/https_proxy, which the
    # node fetch this replaced also ignored.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    started = time.monotonic()
    deadline = started + timeout_ms / 1000
    last_error = "not attempted"
    attempt = 0
    last_progress_at = 0.0

    log(f"waiting for {url} (timeout {format_duration(timeout_ms)})")
    while time.monotonic() < deadline:
        attempt += 1
        status: int | None = None
        body = b""
        outcome_header = ""
        try:
            with opener.open(url, timeout=10) as response:
                status = response.status
                body = response.read(4096)
                outcome_header = response.headers.get("x-edge-request-outcome", "")
        except urllib.error.HTTPError as error:
            status = error.code
            try:
                body = error.read(4096)
            except OSError:
                body = b""
            outcome_header = error.headers.get("x-edge-request-outcome", "") or ""
        except Exception as error:  # URLError, timeout, ConnectionReset, ...
            last_error = str(error)

        if status is not None and status < 500:
            elapsed = format_duration((time.monotonic() - started) * 1000)
            if 200 <= status < 400:
                log(
                    f"{url} responded with {status}; treating service as "
                    f"ready after {elapsed} and {attempt} attempt(s)"
                )
            else:
                text = body.decode(errors="replace").strip()
                text = text if len(text) <= 160 else text[:159] + "…"
                suffix = (f", outcome={outcome_header}" if outcome_header else "") + (
                    f", body={json.dumps(text)}" if text else ""
                )
                log(
                    f"{url} responded with {status}; treating service as "
                    f"ready because it is serving HTTP (non-5xx) after "
                    f"{elapsed} and {attempt} attempt(s){suffix}"
                )
            return
        if status is not None:
            last_error = f"{status} {body.decode(errors='replace')[:200]}"

        now = time.monotonic()
        if attempt == 1 or now - last_progress_at >= 10:
            last_progress_at = now
            log(
                f"still waiting for {url} after "
                f"{format_duration((now - started) * 1000)} "
                f"(attempt {attempt}, last error: {last_error})"
            )
        time.sleep(2)

    fail(
        f"Timed out waiting for {url} after "
        f"{format_duration((time.monotonic() - started) * 1000)}: {last_error}"
    )


# ---------------------------------------------------------------------------
# Version descriptions (status output, access summary, CI step summary)
# ---------------------------------------------------------------------------


def describe_artifact_source(resolved: str) -> str:
    """Human-readable version from a resolved artifact selector, e.g.
    `github-release:wasmerio/edge:v2026-07-07_5:edge` →
    `v2026-07-07_5 (github-release from wasmerio/edge)`."""
    if resolved.startswith("github-release:"):
        repo, _, rest = resolved.removeprefix("github-release:").partition(":")
        tag = rest.partition(":")[0]
        return f"{tag} (github-release from {repo})"
    if resolved.startswith("github-artifact:"):
        repo, _, name = resolved.removeprefix("github-artifact:").partition(":")
        return f"{name} (latest artifact from {repo})"
    if resolved.startswith("artifact:"):
        repo, _, rest = resolved.removeprefix("artifact:").partition(":")
        run_id, _, name = rest.partition(":")
        return f"{name} (artifact from {repo} run {run_id})"
    return resolved  # path:/url:/image refs are already self-describing


def describe_backend_version(ctx: Ctx) -> str:
    description = ctx.get("BACKEND_IMAGE_REF")
    if ctx.get("BACKEND_IMAGE_SOURCE"):
        description += (
            f" (from {describe_artifact_source(ctx.get('BACKEND_IMAGE_SOURCE'))})"
        )
    return description


def describe_edge_version(ctx: Ctx) -> str:
    description = describe_artifact_source(
        ctx.get("EDGE_RESOLVED") or ctx.get("EDGE_VERSION")
    )
    if ctx.run_dir is not None:
        edge_binary = ctx.run_dir / "artifacts" / "edge"
        if edge_binary.is_file():
            # Best-effort self-report from the exact binary the edge container
            # mounts; silently omitted if the binary won't run on the host.
            reported = try_output(
                [str(edge_binary), "--version"], env=ctx.env, timeout=5
            )
            first_line = reported.splitlines()[0].strip() if reported else ""
            if first_line:
                description += f" — binary reports: {first_line[:80]}"
    return description


# ---------------------------------------------------------------------------
# Misc small helpers
# ---------------------------------------------------------------------------


def remove_path_if_exists(path: Path) -> None:
    if path.is_symlink() or path.exists():
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()


def tail_lines(path: Path, count: int) -> Iterable[str]:
    from collections import deque

    with open(path, errors="replace") as handle:
        return deque(handle, maxlen=count)
