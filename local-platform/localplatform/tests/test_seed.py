"""Unit tests for seed binding and hooks (seed.py, D-5/D-6)."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from localplatform.config import apply_config
from localplatform.lib import Ctx, Fail
from localplatform.seed import (
    release_held_scenarios,
    run_post_up_hook,
    scenario_files,
    seed_scenarios,
)

FAKE_ASS = """#!/usr/bin/env sh
# Records every invocation; serves canned `status --json` output.
printf '%s\\n' "$*" >> "$ASS_CALL_LOG"
if [ "$1" = "status" ]; then
  cat "$ASS_STATUS_JSON"
fi
exit "${ASS_EXIT_CODE:-0}"
"""


class SeedTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.parent = Path(self._tmp.name)
        self.repo = self.parent / "integration-tests"
        self.repo.mkdir()
        self.run_dir = self.repo / "run"
        (self.run_dir / "logs").mkdir(parents=True)

    def make_ctx(self, env: dict[str, str] | None = None) -> Ctx:
        ctx = Ctx(env=env or {})
        ctx.repo_dir = self.repo
        ctx.run_dir = self.run_dir
        return ctx

    def install_fake_ass(self, ctx: Ctx, held: list[dict] | None = None) -> Path:
        (self.repo / "bin").mkdir(exist_ok=True)
        (self.repo / "node_modules" / ".bin").mkdir(parents=True, exist_ok=True)
        (self.repo / "node_modules" / ".bin" / "tsx").touch()
        ass = self.repo / "bin" / "ass"
        ass.write_text(FAKE_ASS)
        ass.chmod(0o755)
        call_log = self.repo / "ass-calls.log"
        status_json = self.repo / "ass-status.json"
        status_json.write_text(json.dumps({"held": held or []}))
        ctx.env["ASS_CALL_LOG"] = str(call_log)
        ctx.env["ASS_STATUS_JSON"] = str(status_json)
        ctx.env["PATH"] = os.environ.get("PATH", "")
        return call_log

    def write_scenario(self, name: str) -> Path:
        path = self.parent / name
        path.write_text("assSchema = 1\n")
        return path

    def config_with_scenarios(self, ctx: Ctx, *names: str) -> None:
        listing = ", ".join(f'"{name}"' for name in names)
        (self.parent / "local-platform.toml").write_text(
            f"[seed]\nscenarios = [{listing}]\n"
        )
        apply_config(ctx)


class TestScenarioSelection(SeedTestCase):
    def test_config_list_resolves_against_the_config_file(self) -> None:
        ctx = self.make_ctx()
        self.config_with_scenarios(ctx, "a.toml", "sub/b.toml")
        self.assertEqual(
            scenario_files(ctx),
            [(self.parent / "a.toml").resolve(), (self.parent / "sub/b.toml").resolve()],
        )

    def test_higher_layer_wins_wholesale(self) -> None:
        (self.parent / "local-platform.toml").write_text(
            '[seed]\nscenarios = ["a.toml", "b.toml"]\n'
        )
        (self.parent / "local-platform.local.toml").write_text(
            '[seed]\nscenarios = ["c.toml"]\n'
        )
        ctx = self.make_ctx()
        apply_config(ctx)
        self.assertEqual(scenario_files(ctx), [(self.parent / "c.toml").resolve()])

    def test_override_beats_the_config_and_resolves_against_cwd(self) -> None:
        ctx = self.make_ctx()
        self.config_with_scenarios(ctx, "a.toml")
        ctx.env["LOCAL_PLATFORM_SCENARIOS"] = "x.toml, y.toml"
        self.assertEqual(
            scenario_files(ctx),
            [Path("x.toml").resolve(), Path("y.toml").resolve()],
        )

    def test_empty_override_boots_unseeded(self) -> None:
        ctx = self.make_ctx()
        self.config_with_scenarios(ctx, "a.toml")
        ctx.env["LOCAL_PLATFORM_SCENARIOS"] = ""
        self.assertEqual(scenario_files(ctx), [])

    def test_no_config_means_no_seeding(self) -> None:
        self.assertEqual(scenario_files(self.make_ctx()), [])


class TestSeedScenarios(SeedTestCase):
    def test_seeds_each_file_in_order(self) -> None:
        ctx = self.make_ctx()
        a, b = self.write_scenario("a.toml"), self.write_scenario("b.toml")
        self.config_with_scenarios(ctx, "a.toml", "b.toml")
        call_log = self.install_fake_ass(ctx)
        seed_scenarios(ctx)
        self.assertEqual(
            call_log.read_text().splitlines(),
            [f"up --file {a.resolve()}", f"up --file {b.resolve()}"],
        )

    def test_missing_ass_deps_is_a_hard_error_naming_make_setup(self) -> None:
        ctx = self.make_ctx()
        self.write_scenario("a.toml")
        self.config_with_scenarios(ctx, "a.toml")
        with self.assertRaisesRegex(Fail, "make setup"):
            seed_scenarios(ctx)

    def test_missing_scenario_file_is_a_hard_error(self) -> None:
        ctx = self.make_ctx()
        self.config_with_scenarios(ctx, "ghost.toml")
        self.install_fake_ass(ctx)
        with self.assertRaisesRegex(Fail, "ghost.toml"):
            seed_scenarios(ctx)

    def test_failing_seed_fails_up(self) -> None:
        ctx = self.make_ctx()
        self.write_scenario("a.toml")
        self.config_with_scenarios(ctx, "a.toml")
        self.install_fake_ass(ctx)
        ctx.env["ASS_EXIT_CODE"] = "3"
        with self.assertRaisesRegex(Fail, "status 3") as caught:
            seed_scenarios(ctx)
        self.assertEqual(caught.exception.code, 3)

    def test_unseeded_needs_no_ass(self) -> None:
        seed_scenarios(self.make_ctx())  # no config, no bin/ass: no-op


class TestPostUpHook(SeedTestCase):
    def hook_ctx(self, command: str) -> Ctx:
        (self.parent / "local-platform.toml").write_text(
            f"[hooks]\npost_up = '''{command}'''\n"
        )
        ctx = self.make_ctx(env={"PATH": os.environ.get("PATH", "")})
        apply_config(ctx)
        (self.run_dir / "test-env.sh").write_text(
            "export WASMER_REGISTRY='http://localhost:1/graphql'\n"
        )
        return ctx

    def test_runs_from_config_dir_with_platform_env(self) -> None:
        ctx = self.hook_ctx('printf "%s %s" "$PWD" "$WASMER_REGISTRY" > hook-out')
        run_post_up_hook(ctx)
        self.assertEqual(
            (self.parent / "hook-out").read_text(),
            f"{self.parent} http://localhost:1/graphql",
        )

    def test_nonzero_hook_fails_up_with_the_command_named(self) -> None:
        ctx = self.hook_ctx("echo doomed >&2; exit 7")
        with self.assertRaisesRegex(Fail, "post_up hook failed") as caught:
            run_post_up_hook(ctx)
        self.assertEqual(caught.exception.code, 7)
        self.assertIn("doomed", (self.run_dir / "logs" / "post-up-hook.log").read_text())

    def test_no_hook_is_a_no_op(self) -> None:
        run_post_up_hook(self.make_ctx())


class TestReleaseHeldScenarios(SeedTestCase):
    def test_releases_every_held_slug(self) -> None:
        ctx = self.make_ctx()
        call_log = self.install_fake_ass(
            ctx, held=[{"slug": "one"}, {"slug": "two"}]
        )
        release_held_scenarios(ctx)
        self.assertEqual(
            call_log.read_text().splitlines(),
            ["status --json", "down one", "down two"],
        )

    def test_nothing_held_releases_nothing(self) -> None:
        ctx = self.make_ctx()
        call_log = self.install_fake_ass(ctx, held=[])
        release_held_scenarios(ctx)
        self.assertEqual(call_log.read_text().splitlines(), ["status --json"])

    def test_missing_ass_deps_is_a_silent_no_op(self) -> None:
        release_held_scenarios(self.make_ctx())


if __name__ == "__main__":
    unittest.main()
