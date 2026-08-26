Overview on contribution requirements & guidelines

> This file is the canonical agent guidance. `CLAUDE.md` is a symlink to it, and
> `.claude/` is a symlink to `.agents/`, so every agent reads the same rules.

## Before committing or pushing (CI gates)

CI runs `make lint`, which is `fmt-check` + `tsc --noEmit` + `eslint`. A
mis-formatted file fails the **File format check** job and blocks the PR, even
if nothing else changed. So, before every commit/push:

```bash
make fmt    # auto-format (Prettier) — never hand-format
make lint   # fmt-check + typecheck + eslint; must pass cleanly
```

Notes:

- `make fmt` formats the whole repo (`prettier "**/*"`), so it catches files you
  did not directly edit (config, JS reporters, docs). Run it, don't just format
  the file you touched.
- If you add a generated/vendored/local-only file that must not be formatted,
  add it to `.prettierignore` (and `.gitignore` if it should not be committed).

## Build, lint, test

- Prereq: Node 22+, pnpm (plus Python 3.12+ for the local platform tooling). First run: make setup
- Format: make fmt (check only: make fmt-check)
- Lint + typecheck: make check (runs: npx tsc --noEmit and eslint)
- Test all against the default remote/dev environment: make test or pnpm test
- Run a single file: npx jest tests/path/to/file.test.ts
- Run tests by name: npx jest -t "partial test name"
- Increase logging: VERBOSE=true npx jest … (command/env output is truncated unless VERBOSE=true)

### Failure reproductions (ASS)

- ASS is the declarative failure-reproduction harness (`ass/`, design in `docs/anti-slop-shield-v1.md`). Invoke it as `./bin/ass …` or `pnpm ass …` (`pnpm run` prints a preamble that breaks the harness's single-voice output; `./bin/ass` avoids it).
- Check the machine: `./bin/ass doctor` — per-capability pass/fail with remediation; missing optional tools degrade one capability each. First-time setup: `make ass` hands the setup contract (`ass/bootstrap/SETUP.md`) to your agent harness.
- Drafts live in `experiments/<slug>/` and run with `./bin/ass try <slug>`; persisted reproductions live in `repros/<slug>/` and run with `./bin/ass run <slug>`. `./bin/ass promote <slug>` graduates a draft, pinning it to what its last recorded run resolved.
- Overrides are the same on both (D12): `--env`, `--cpus`, `--executor`, `--component <name>=<selector>`, with `--edge`/`--backend` as sugar. Overriding a component is how a fix is verified; it never edits the declaration.
- Workloads run through one of `jest`, `artillery-http` or `raw-wasmer`; `verdict.baseline` additionally runs the same probe on a native engine (`python3`, `node`, `go`, `cargo`, `binary`) so a reproduction claim is a measured divergence, not an assertion. A self-verdicting probe states its result in one `ASS-VERDICT: reproduced|not-reproduced|inconclusive [detail]` line on a declared channel.
- Only `edge` and `backend` need the local stack. A scenario with neither (nor an app fixture, perturbation or `edge`/`backend` log predicate) runs without booting anything — `./bin/ass run wax-603` takes ~30s.
- Remote targets: `--env dev|bugtopia|prod` runs through the standard `TestEnv` identity flow (token from `WASMER_TOKEN` or `~/.wasmer/wasmer.toml`). The harness deploys `package:` probe fixtures as apps on demand, reads verdicts off the D14-windowed app logs and the HTTP body, and tears them down — `./bin/ass run wax-603 --env dev --executor artillery-http` is the reference. Perturbations are ignored remotely (loud warning); declared `edge`/`backend` pins derive a floating-mode run. Production additionally requires `--i-know-this-is-prod`, an interactive confirmation, and fixed non-overridable load caps; stress profiles and `jest` workloads refuse prod outright.

### Local platform test flow

- Full disposable local stack + tests: make local-test
- Target a specific local test/suite: `LOCAL_TEST_COMMAND='pnpm exec jest tests/validation/log.test.ts --runInBand' make local-test`
- Bring the local stack up without running tests: make local-platform-up
- Then load the generated env and run targeted tests manually:
  - `source .local-platform/current/test-env.sh`
  - `pnpm exec jest tests/validation/log.test.ts --runInBand`
- Stop the local stack: make local-platform-down
- Local platform configuration is layered TOML read by `cli.py` (`local-platform.local.toml` here, or `local-platform.toml`/`local-platform.local.toml` in a parent repo vendoring this one; env vars win); defaults otherwise `resolve_prod`. See `docs/local-environment-v1.md`.
- The local platform tooling is dependency-free Python 3.12+ (`local-platform/cli.py` + `local-platform/localplatform/`); the make targets above are thin wrappers around it. The `.mjs` seeding/config helpers under `local-platform/scripts/` are Node and invoked by it.
- Troubleshooting runbook (log/diagnostic locations, the `*.localhost` Edge-routing gotcha, validation-vs-jest timeouts, dev-vs-local comparison): see `docs/local-environment-v1.md` → "Troubleshooting (agent runbook)". Key rule: reach apps via `env.fetchApp`/`env.fetchAppUrlThroughEdge`, never a raw `fetch` — raw fetch works on dev but hangs on the local stack.

## Environment for integration tests

- Defaults target the Wasmer dev backend; token is read from ~/.wasmer/wasmer.toml if not set.
- Key vars: WASMER_REGISTRY, WASMER_NAMESPACE, WASMER_TOKEN, WASMER_APP_DOMAIN, EDGE_SERVER, WASMER_PATH

## Code style guidelines

- Modules/imports: ESM only. Order: node builtins (prefer node: specifier) → third‑party → local (src/…). Use named imports when possible.
- Dependencies: standard library first. Prefer node: builtins to their fullest extent (util.parseArgs for flat flag parsing, node:fs, node:crypto) before reaching for a package; add a third-party dependency only when the stdlib genuinely cannot cover the need. Sanctioned exception: commander for CLI subcommand routing, which util.parseArgs does not provide (see worklog D16).
- Formatting: Prettier (see .prettierignore). Do not hand-format; run make fmt.
- Linting: ESLint 9 + typescript-eslint recommended config. Fix only issues in changed lines.
- Types: Avoid any. Prefer unknown + zod parsing where needed. Add explicit return types for exported functions. Use interfaces/types for shapes.
- Naming: camelCase for vars/functions; PascalCase for types/classes; UPPER_SNAKE_CASE for constants (e.g., env var names).
- Errors: Throw Error with actionable context (inputs, ids). Don’t swallow errors. For command/fetch helpers, use noAssertSuccess to opt out of default assertions.
- Async: Prefer async/await. Avoid unhandled promises. Respect jest timeouts (default 180s) and use provided sleep util for polling.
- Logging: Use console.debug/info sparingly. Never log secrets/tokens. Honor VERBOSE and MAX_LINE_PRINT_LENGTH.
- Tests: Always use TestEnv helpers for CLI calls and HTTP to Edge to respect env/registry/namespace. Place tests under tests/<domain>. When adding or changing tests, follow the `add-integration-test` skill (.agents/skills/add-integration-test/SKILL.md).
