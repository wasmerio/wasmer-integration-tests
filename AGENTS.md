Overview on contribution requirements & guidelines

## Build, lint, test

- Prereq: Node 22+, pnpm. First run: make setup
- Format: make fmt (check only: make fmt-check)
- Lint + typecheck: make check (runs: npx tsc --noEmit and eslint)
- Test all: make test or pnpm test
- Run a single file: npx jest tests/path/to/file.test.ts
- Run tests by name: npx jest -t "partial test name"
- Increase logging: VERBOSE=true npx jest … (command/env output is truncated unless VERBOSE=true)

## Environment for integration tests

- Defaults target the Wasmer dev backend; token is read from ~/.wasmer/wasmer.toml if not set.
- Key vars: WASMER_REGISTRY, WASMER_NAMESPACE, WASMER_TOKEN, WASMER_APP_DOMAIN, EDGE_SERVER, WASMER_PATH

## Code style guidelines

- Modules/imports: ESM only. Order: node builtins (prefer node: specifier) → third‑party → local (src/…). Use named imports when possible.
- Formatting: Prettier (see .prettierignore). Do not hand-format; run make fmt.
- Linting: ESLint 9 + typescript-eslint recommended config. Fix only issues in changed lines.
- Types: Avoid any. Prefer unknown + zod parsing where needed. Add explicit return types for exported functions. Use interfaces/types for shapes.
- Naming: camelCase for vars/functions; PascalCase for types/classes; UPPER_SNAKE_CASE for constants (e.g., env var names).
- Errors: Throw Error with actionable context (inputs, ids). Don’t swallow errors. For command/fetch helpers, use noAssertSuccess to opt out of default assertions.
- Async: Prefer async/await. Avoid unhandled promises. Respect jest timeouts (default 180s) and use provided sleep util for polling.
- Logging: Use console.debug/info sparingly. Never log secrets/tokens. Honor VERBOSE and MAX_LINE_PRINT_LENGTH.
- Tests: Always use TestEnv helpers for CLI calls and HTTP to Edge to respect env/registry/namespace. Place tests under tests/<domain>.
