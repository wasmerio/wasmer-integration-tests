# Local Environment v1

Run `wasmer-integration-tests` against a disposable local Wasmer stack built from a selected Backend image and Edge binary.

## What it does

`make local-test` now:

1. resolves concrete Backend and Edge inputs;
2. starts a disposable Docker Compose stack on isolated localhost ports;
3. bootstraps Backend config and local test env files;
4. seeds package dependencies into the local registry;
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
export LOCAL_TEST_COMMAND='pnpm exec jest ./tests/general/'
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

## Notes

- The stack intentionally uses the latest dependency images for supporting services.
- Local package seeding mirrors public package dependencies into the disposable local registry before tests run.
- Edge compiler and package caches are persisted under `.local-platform/cache/edge` so repeated runs are faster.
