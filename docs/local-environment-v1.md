# Local Environment v1

Run `wasmer-integration-tests` against a disposable local Wasmer stack built from a selected Backend image and Edge binary.

## What it does

`make local-test` now:

1. resolves concrete Backend and Edge inputs;
2. starts a disposable Docker Compose stack on isolated localhost ports;
3. bootstraps Backend config and local test env files;
4. seeds app templates and package dependencies into the local registry;
5. warms the Edge compiler cache;
6. runs the requested Jest command against the local stack;
7. collects logs and tears everything down.

`make local-platform-up` runs the same setup flow but leaves the stack running for manual debugging.

## Supported selectors

The local platform currently supports only these selectors:

- `BACKEND_VERSION`
- `EDGE_VERSION`

Example `local.env`:

```bash
export BACKEND_VERSION=resolve_prod
export EDGE_VERSION=resolve_prod
export LOCAL_TEST_COMMAND='pnpm exec jest'
```

## Commands

### Run the full flow

```bash
make local-test
```

### Bring the stack up and keep it running

```bash
make local-platform-up
source .local-platform/current/test-env.sh
pnpm exec jest tests/validation/log.test.ts --runInBand
make local-platform-down
```

### Prepare the stack without running tests

```bash
make local-platform-prepare
```

This validates that the local stack can boot, bootstrap, seed packages, and shut down cleanly.

## Runtime outputs

Each run writes state under:

```text
.local-platform/runs/<timestamp>-<sha>/
```

Important files:

- `resolved.env` / `resolved.json`: resolved Backend and Edge inputs
- `backend.env`: generated Backend runtime env
- `test-env.sh`: env file to source before manual test runs
- `edge/platform_config.yaml`: generated Edge config
- `artifacts/edge`: resolved Edge binary
- `artifacts/relay-persisted-queries.json`: currently an empty manifest placeholder
- `logs/`: collected service and test logs
- `diagnostics/`: compose config, stats, cache diagnostics, and package seed output

## Troubleshooting (agent runbook)

### Reaching apps locally — never use a raw `fetch`

Deployed apps get canonical URLs like `https://<app>.localhost`, but on the
local platform **Edge listens on isolated host ports** (HTTP `19080`, HTTPS
`19443`) and nothing listens on `:80`/`:443`. So the canonical app URL is _not_
directly routable on the host.

Tests must reach apps through the `TestEnv` Edge helpers, which send the request
to `EDGE_SERVER` with the app host as the `Host` header and rewrite redirect
`Location`s that point at the in-container `:9443` port:

- `env.fetchApp(app, path, opts)` — preferred; also waits for the deployed
  version unless `noWait: true`.
- `env.fetchAppUrlThroughEdge(url, opts)` — when you only have a URL string
  (used by `validateWordpressIsLive`). Falls back to a direct `fetch` when no
  `EDGE_SERVER` is set (i.e. against the dev/remote backend).

A raw `fetch(appUrl)` works against the dev backend (real DNS + standard ports)
but **hangs against the local stack**. If a test passes on dev but times out
locally on an HTTP assertion, suspect a raw `fetch` that bypasses the Edge
helpers. WordPress's not-installed `/` → install-wizard `302` is the classic
trap: a raw fetch loops on the 302 forever.

### Validation timeout vs. jest timeout

`LOCAL_PLATFORM_RELAX_EDGE_VERSION_HEADER=1` (set in `test-env.sh`) raises some
poll budgets — e.g. WordPress validation to 120×2s = 240s, which exceeds the
180s jest `testTimeout`. When that happens the descriptive validator error
(HTTP status + body excerpt) is replaced by a generic "Exceeded timeout"
message. If you see a bare jest timeout, lower the retry budget to surface the
real reason, e.g. `WASMER_TEST_WORDPRESS_MAX_RETRIES=4 VERBOSE=true`.

### Where to look when an app misbehaves

- Per-suite test output: `.local-platform/current/logs/tests.log`
- Per-service container logs: `.local-platform/current/logs/<service>.log`
  (backend, edge, postgres, mysql_app_db_1/2, clickhouse, loki, vector, …) —
  regenerate with `make local-platform-logs`.
- App (instance) logs are surfaced inline in `tests.log` for failing tests
  (apps for failing tests are preserved by default; use `KEEP_APPS=1` to keep
  them for passing tests too).
- Compose/topology/stats snapshots: `.local-platform/current/diagnostics/`.

### Comparing against the dev backend

When a local failure is suspected to be environmental, reproduce it against dev:
unset the local-platform vars (`WASMER_REGISTRY`, `WASMER_NAMESPACE`,
`WASMER_APP_DOMAIN`, `EDGE_SERVER`, `EDGE_SSH_SERVER`, `EDGE_DNS_SERVER`,
`LOCAL_PLATFORM_*`, `CLICKHOUSE_*`), point at the dev registry/token, and rerun.
If it fails on dev too, it's a test bug; if only locally, it's a wiring issue.

## Reuse behavior

`make local-platform-up` reuses `.local-platform/current` only when the requested `BACKEND_VERSION` and `EDGE_VERSION` match the already running stack.

If the selectors changed, the old stack is automatically stopped before a new one is created.

## Ports

Default host ports:

- Backend GraphQL: `18000`
- Edge HTTP: `19080`
- Edge HTTPS: `19443`
- Edge Node API: `19050`
- Edge gRPC: `19051`
- Edge SSH: `19022`
- Edge DNS: `19053/udp`
- Postgres: `15432`
- Redis: `16379`
- MySQL: `13306`, `13307`
- MinIO: `19100`, `19101`
- ClickHouse: `18123`, `19123`
- Loki: `13100`
- Vector: `19089`

Override any of them through `local.env` before starting the stack.

## CI shape

The reusable workflow `.github/workflows/local-platform-test.yaml` accepts only:

- `backend_version`
- `edge_version`
- `test_command`
- `prepare_only`
- `suite_id`
- `job_name`

Code QA first warms the shared local-platform caches once, then fans out the suite matrix using the same reusable workflow.

## Implementation

The tooling is dependency-free Python (3.12+, standard library only). The
entry point is `local-platform/cli.py` (`up`, `down`, `local-test`, `prepare`,
`logs`, `collect-logs`, `status`), and the make targets are thin wrappers
around it. One module per phase lives in `local-platform/localplatform/`:
`resolve`, `fetch`, `bootstrap`, `ensure_compiled`, `up`, `down`, `logs`,
`status`, `local_test`, with shared plumbing in `lib.py`. The substantial Node
helpers under `local-platform/scripts/` (`seed-app-templates.mjs`,
`seed-packages.mjs`, `generate-edge-config.mjs`,
`persist-relay-queries.mjs`) are invoked by the Python tooling. The only
remaining bash is `bash -lc` around `LOCAL_TEST_COMMAND`, which is
contractually a (possibly multi-line) shell snippet from
`.github/integration-test-suites.json`.

Fresh boots run independent steps concurrently (backend image pull, Edge
binary download, dependency services, Edge helper-image prebuild; later
template seeding overlaps the backend start, and package seeding overlaps
Relay persistence). When concurrent steps stream into CI logs their lines are
prefixed (`[packages] …`). Per-step wall times land in
`<run>/diagnostics/timings.json` and the slowest steps are summarized in the
"Local platform ready" log line.

`make local-platform-status` prints the current run, the resolved Backend and
Edge versions actually in use (not just floating selectors like
`resolve_prod`; the Backend line warns if the running container's image
differs from the resolved one, and the Edge line includes the binary's
self-reported `--version` when obtainable), per-service container state, and
live backend/Edge probes (exit 0 only when both serve HTTP).

The same resolved-versions block is part of the access summary printed after
every successful `up` (so CI logs for both the prepare gate and each suite job
show what is running), and when `GITHUB_STEP_SUMMARY` is set a markdown
"Local platform versions" table is appended to the GitHub Actions job page.

Unit tests for the pure logic (env-file scanner, selector/gate semantics,
package-list builder, token redaction, JWT signing) live in
`local-platform/localplatform/tests/` and run as part of `make check` via
`python3 -m unittest discover -s ./local-platform -p 'test_*.py'`.

## Notes

- The stack intentionally uses the latest dependency images for supporting services.
- Local package seeding mirrors public package dependencies into the disposable local registry before tests run.
- App templates are seeded by this repo's own `local-platform/scripts/seed-app-templates.mjs` (bootstrap passes `--skip-templates` to the backend's embedded seeder when the image supports it). This keeps bootstrap independent of the GraphQL template contract baked into a given backend image; if the public registry's `getAppTemplates` contract changes, update `QUERY_VARIANTS` in that script. Set `LOCAL_PLATFORM_USE_BACKEND_TEMPLATE_SEEDER=1` to fall back to the embedded seeder, or `LOCAL_PLATFORM_SEED_TEMPLATES=0` to skip template seeding entirely.
- Edge compiler and package caches are persisted under `.local-platform/cache/edge` so repeated runs are faster.
