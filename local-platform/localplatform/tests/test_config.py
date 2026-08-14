"""Unit tests for the layered TOML config loader (config.py).

Run via `make check`, or directly:

    python3 -m unittest discover -s ./local-platform -p 'test_*.py'
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from localplatform.config import apply_config, load_config
from localplatform.lib import Ctx, Fail


class ConfigTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.parent = Path(self._tmp.name)
        self.repo = self.parent / "integration-tests"
        self.repo.mkdir()

    def write(self, path: Path, text: str) -> Path:
        path.write_text(text)
        return path

    def make_ctx(self, env: dict[str, str] | None = None) -> Ctx:
        ctx = Ctx(env=env or {})
        ctx.repo_dir = self.repo
        return ctx


class TestPrecedence(ConfigTestCase):
    def test_consumer_file_translates_onto_env_knobs(self) -> None:
        self.write(
            self.parent / "local-platform.toml",
            '[platform]\nstripe_mock = true\nbackend_version = "resolve_dev"\n',
        )
        ctx = self.make_ctx()
        apply_config(ctx)
        self.assertEqual(ctx.env["LOCAL_PLATFORM_STRIPE_MOCK"], "1")
        self.assertEqual(ctx.env["BACKEND_VERSION"], "resolve_dev")

    def test_local_file_overrides_consumer_file(self) -> None:
        self.write(
            self.parent / "local-platform.toml", "[platform]\nstripe_mock = true\n"
        )
        self.write(
            self.parent / "local-platform.local.toml",
            "[platform]\nstripe_mock = false\n",
        )
        ctx = self.make_ctx()
        apply_config(ctx)
        self.assertEqual(ctx.env["LOCAL_PLATFORM_STRIPE_MOCK"], "0")

    def test_repo_local_file_overrides_parent_files(self) -> None:
        self.write(
            self.parent / "local-platform.local.toml",
            '[platform]\nedge_version = "parent"\n',
        )
        self.write(
            self.repo / "local-platform.local.toml",
            '[platform]\nedge_version = "standalone"\n',
        )
        ctx = self.make_ctx()
        apply_config(ctx)
        self.assertEqual(ctx.env["EDGE_VERSION"], "standalone")

    def test_process_env_overrides_every_file(self) -> None:
        self.write(
            self.parent / "local-platform.toml", "[platform]\nstripe_mock = true\n"
        )
        ctx = self.make_ctx(env={"LOCAL_PLATFORM_STRIPE_MOCK": "0"})
        apply_config(ctx)
        self.assertEqual(ctx.env["LOCAL_PLATFORM_STRIPE_MOCK"], "0")

    def test_empty_env_value_falls_through_to_file(self) -> None:
        self.write(
            self.parent / "local-platform.toml",
            '[platform]\nbackend_version = "resolve_dev"\n',
        )
        ctx = self.make_ctx(env={"BACKEND_VERSION": ""})
        apply_config(ctx)
        self.assertEqual(ctx.env["BACKEND_VERSION"], "resolve_dev")

    def test_explicit_config_is_the_highest_priority_file(self) -> None:
        self.write(
            self.repo / "local-platform.local.toml",
            "[platform]\npackage_concurrency = 2\n",
        )
        explicit = self.write(
            self.parent / "elsewhere.toml", "[platform]\npackage_concurrency = 9\n"
        )
        ctx = self.make_ctx()
        apply_config(ctx, str(explicit))
        self.assertEqual(ctx.env["LOCAL_PLATFORM_PACKAGE_CONCURRENCY"], "9")

    def test_missing_explicit_config_is_an_error(self) -> None:
        ctx = self.make_ctx()
        with self.assertRaisesRegex(Fail, "does-not-exist.toml"):
            apply_config(ctx, str(self.parent / "does-not-exist.toml"))


class TestTypesAndKeys(ConfigTestCase):
    def test_ints_and_lists_stringify(self) -> None:
        self.write(
            self.repo / "local-platform.local.toml",
            "[platform]\n"
            "package_concurrency = 4\n"
            'priority_packages = ["wasmer/hello", "python/python"]\n'
            "[local_test]\n"
            'command = "pnpm exec jest"\n',
        )
        ctx = self.make_ctx()
        apply_config(ctx)
        self.assertEqual(ctx.env["LOCAL_PLATFORM_PACKAGE_CONCURRENCY"], "4")
        self.assertEqual(
            ctx.env["LOCAL_PLATFORM_PRIORITY_PACKAGES"], "wasmer/hello,python/python"
        )
        self.assertEqual(ctx.env["LOCAL_TEST_COMMAND"], "pnpm exec jest")

    def test_ports_map_onto_port_env_vars(self) -> None:
        self.write(
            self.repo / "local-platform.local.toml",
            "[ports]\nbackend_http = 28000\nmysql_app_db_2 = 13317\n",
        )
        ctx = self.make_ctx()
        apply_config(ctx)
        self.assertEqual(ctx.env["BACKEND_HTTP_PORT"], "28000")
        self.assertEqual(ctx.env["MYSQL_APP_DB_2_PORT"], "13317")

    def test_wrong_type_is_an_error_naming_the_key(self) -> None:
        path = self.write(
            self.repo / "local-platform.local.toml",
            '[platform]\nstripe_mock = "yes"\n',
        )
        with self.assertRaisesRegex(Fail, "platform.stripe_mock") as caught:
            load_config(self.repo)
        self.assertIn(str(path), str(caught.exception))

    def test_bool_is_not_an_int(self) -> None:
        self.write(
            self.repo / "local-platform.local.toml",
            "[platform]\npackage_concurrency = true\n",
        )
        with self.assertRaisesRegex(Fail, "platform.package_concurrency"):
            load_config(self.repo)

    def test_non_integer_port_is_an_error(self) -> None:
        self.write(
            self.repo / "local-platform.local.toml", '[ports]\nbackend_http = "x"\n'
        )
        with self.assertRaisesRegex(Fail, "ports.backend_http"):
            load_config(self.repo)

    def test_unknown_key_names_file_key_and_accepted_set(self) -> None:
        path = self.write(
            self.repo / "local-platform.local.toml", "[platform]\nstrpe_mock = true\n"
        )
        with self.assertRaisesRegex(Fail, "platform.strpe_mock") as caught:
            load_config(self.repo)
        message = str(caught.exception)
        self.assertIn(str(path), message)
        self.assertIn("stripe_mock", message)

    def test_unknown_table_is_an_error(self) -> None:
        self.write(self.repo / "local-platform.local.toml", "[platfrm]\nx = 1\n")
        with self.assertRaisesRegex(Fail, "platfrm"):
            load_config(self.repo)

    def test_unknown_port_names_the_accepted_services(self) -> None:
        self.write(
            self.repo / "local-platform.local.toml", "[ports]\ngarnish = 1234\n"
        )
        with self.assertRaisesRegex(Fail, "backend_http"):
            load_config(self.repo)

    def test_invalid_toml_is_an_error_naming_the_file(self) -> None:
        path = self.write(self.repo / "local-platform.local.toml", "[platform\n")
        with self.assertRaisesRegex(Fail, "invalid TOML") as caught:
            load_config(self.repo)
        self.assertIn(str(path), str(caught.exception))


class TestSeedAndHooks(ConfigTestCase):
    def test_seed_and_hooks_parse_relative_to_their_file(self) -> None:
        self.write(
            self.parent / "local-platform.toml",
            '[seed]\nscenarios = ["scenarios/base.toml"]\n'
            '[hooks]\npost_up = "./hook.sh"\n',
        )
        config = load_config(self.repo)
        self.assertEqual(
            config.seed_scenarios,
            [(self.parent / "scenarios/base.toml").resolve()],
        )
        self.assertEqual(config.post_up, "./hook.sh")
        self.assertEqual(config.post_up_dir, self.parent)

    def test_seed_rejects_non_string_scenarios(self) -> None:
        self.write(
            self.repo / "local-platform.local.toml", "[seed]\nscenarios = [1]\n"
        )
        with self.assertRaisesRegex(Fail, "seed.scenarios"):
            load_config(self.repo)

    def test_unknown_hook_is_an_error(self) -> None:
        self.write(
            self.repo / "local-platform.local.toml", '[hooks]\npre_up = "x"\n'
        )
        with self.assertRaisesRegex(Fail, "hooks.pre_up"):
            load_config(self.repo)


if __name__ == "__main__":
    unittest.main()
