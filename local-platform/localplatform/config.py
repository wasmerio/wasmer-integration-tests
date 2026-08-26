"""Layered TOML configuration for the local platform.

Lookup order (lowest to highest): `<repo_dir.parent>/local-platform.toml`
(committed by a consumer repo vendoring this one as a submodule),
`<repo_dir.parent>/local-platform.local.toml` (developer overrides),
`<repo_dir>/local-platform.local.toml` (standalone checkouts), then an
explicit `--config PATH`. Process environment variables beat every file.

Keys translate onto the existing `LOCAL_PLATFORM_*`/selector env knobs and
are written into `Ctx.env` before anything reads them, so downstream code
stays untouched. Unknown keys or wrong types are hard errors.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from .lib import PORT_DEFAULTS, fail

if TYPE_CHECKING:
    from .lib import Ctx

CONFIG_NAME = "local-platform.toml"
LOCAL_CONFIG_NAME = "local-platform.local.toml"

# TOML key -> (env knob, accepted type). Booleans/ints are real TOML types,
# stringified at the env boundary.
PLATFORM_KEYS: dict[str, tuple[str, type]] = {
    "backend_version": ("BACKEND_VERSION", str),
    "edge_version": ("EDGE_VERSION", str),
    "stripe_mock": ("LOCAL_PLATFORM_STRIPE_MOCK", bool),
    "ensure_compiled": ("LOCAL_PLATFORM_ENSURE_COMPILED", bool),
    "seed_packages": ("LOCAL_PLATFORM_SEED_PACKAGES", bool),
    "seed_templates": ("LOCAL_PLATFORM_SEED_TEMPLATES", bool),
    "package_concurrency": ("LOCAL_PLATFORM_PACKAGE_CONCURRENCY", int),
    "priority_packages": ("LOCAL_PLATFORM_PRIORITY_PACKAGES", list),
}

LOCAL_TEST_KEYS: dict[str, tuple[str, type]] = {
    "command": ("LOCAL_TEST_COMMAND", str),
}

# `[ports] backend_http = 18000` -> BACKEND_HTTP_PORT etc.
PORT_KEYS: dict[str, str] = {
    var.removesuffix("_PORT").lower(): var for var in PORT_DEFAULTS
}

TOP_LEVEL_TABLES = ("platform", "local_test", "ports", "seed", "hooks")


@dataclass
class Config:
    """Merged view of every config layer; later layers win per key."""

    env: dict[str, str] = field(default_factory=dict)
    # Driven by seed.py: up() seeds/hooks, down() releases (D-5/D-6).
    seed_scenarios: list[Path] = field(default_factory=list)
    post_up: str | None = None
    post_up_dir: Path | None = None


def config_files(repo_dir: Path, explicit: Path | None = None) -> list[Path]:
    """The existing config files, lowest priority first."""
    repo_dir = repo_dir.resolve()
    candidates = [
        repo_dir.parent / CONFIG_NAME,
        repo_dir.parent / LOCAL_CONFIG_NAME,
        repo_dir / LOCAL_CONFIG_NAME,
    ]
    files = [path for path in candidates if path.is_file()]
    if explicit is not None:
        if not explicit.is_file():
            fail(f"--config {explicit}: file does not exist")
        files.append(explicit.resolve())
    return files


def _unknown_key(path: Path, key: str, accepted: object) -> None:
    fail(f"{path}: unknown key {key} (accepted: {', '.join(sorted(accepted))})")


def _stringify(path: Path, key: str, value: object, expected: type) -> str:
    if expected is bool:
        if not isinstance(value, bool):
            fail(f"{path}: {key} must be a boolean, got {type(value).__name__}")
        return "1" if value else "0"
    if expected is int:
        if isinstance(value, bool) or not isinstance(value, int):
            fail(f"{path}: {key} must be an integer, got {type(value).__name__}")
        return str(value)
    if expected is list:
        if not isinstance(value, list) or not all(
            isinstance(item, str) for item in value
        ):
            fail(f"{path}: {key} must be an array of strings")
        return ",".join(value)
    if not isinstance(value, str):
        fail(f"{path}: {key} must be a string, got {type(value).__name__}")
    return value


def _require_table(path: Path, name: str, value: object) -> dict:
    if not isinstance(value, dict):
        fail(f"{path}: [{name}] must be a table")
    return value


def _read_file(path: Path, config: Config) -> None:
    try:
        data = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as error:
        fail(f"{path}: invalid TOML: {error}")

    for table in data:
        if table not in TOP_LEVEL_TABLES:
            _unknown_key(path, table, TOP_LEVEL_TABLES)

    for table, keys in (("platform", PLATFORM_KEYS), ("local_test", LOCAL_TEST_KEYS)):
        for key, value in _require_table(path, table, data.get(table, {})).items():
            spec = keys.get(key)
            if spec is None:
                _unknown_key(path, f"{table}.{key}", keys)
            env_name, expected = spec
            config.env[env_name] = _stringify(
                path, f"{table}.{key}", value, expected
            )

    for key, value in _require_table(path, "ports", data.get("ports", {})).items():
        env_name = PORT_KEYS.get(key)
        if env_name is None:
            _unknown_key(path, f"ports.{key}", PORT_KEYS)
        config.env[env_name] = _stringify(path, f"ports.{key}", value, int)

    seed = _require_table(path, "seed", data.get("seed", {}))
    for key, value in seed.items():
        if key != "scenarios":
            _unknown_key(path, f"seed.{key}", ("scenarios",))
        if not isinstance(value, list) or not all(
            isinstance(item, str) for item in value
        ):
            fail(f"{path}: seed.scenarios must be an array of strings")
        # Scenario paths are relative to the config file's directory.
        config.seed_scenarios = [(path.parent / item).resolve() for item in value]

    hooks = _require_table(path, "hooks", data.get("hooks", {}))
    for key, value in hooks.items():
        if key != "post_up":
            _unknown_key(path, f"hooks.{key}", ("post_up",))
        if not isinstance(value, str):
            fail(f"{path}: hooks.post_up must be a string")
        config.post_up = value
        config.post_up_dir = path.parent


def load_config(repo_dir: Path, explicit: Path | None = None) -> Config:
    config = Config()
    for path in config_files(repo_dir, explicit):
        _read_file(path, config)
    return config


def apply_config(ctx: "Ctx", config_path: str | None = None) -> Config:
    """Translate the config layers into `ctx.env`. A knob already set (and
    non-empty) in the process environment wins over every file."""
    explicit = Path(config_path) if config_path else None
    config = load_config(ctx.repo_dir, explicit)
    for name, value in config.env.items():
        if not ctx.env.get(name):
            ctx.env[name] = value
    ctx.config = config
    return config
