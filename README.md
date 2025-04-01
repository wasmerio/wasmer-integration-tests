# Wasmer Integration Tests

Integration tests for validation the Wasmer product stack, in particular the
CLI, the backend and Edge.

## Running tests

The tests are written in Typescript, and use the `deno` test runner.

Follow the
[Deno installation docs](https://docs.deno.com/runtime/fundamentals/installation/)
to install deno on your system.

- Run all tests: `deno test --allow-all .`
- Run specific test(s), filtered by name:
  `deno test --allow-all --filter <TEST-NAME> .`

Use the `--parallel` flag to run multiple tests in parallel. By default, this
will run tests with a concurrency of local CPU cores. You can use the
`DENO_JOBS` environment variable to control the number of parallel tests..

For example: `DENO_JOBS=8 deno test --allow-all --parallel .`

### Test target environment

Tests are executed against a given test environment, and will create apps in a
specified namespace.

By default the Wasmer dev backend is used.

The test target can be customized with environment variables.

Defaults:

- WASMER_NAMESPACE: 'wasmer-integration-tests' The backend namespace to use for
  the tests. Packages and apps will be created in this namespace.
- WASMER_REGISTRY: 'https://registry.wasmer.wtf/graphql' URL of the backend.
- WASMER_TOKEN: <null> The token for the target backend is retrieved from your
  wasmer config. (~/.wasmer/wasmer.toml) if not specified.
- WASMER_PATH: <null> Path to the wasmer CLI executable. By default the tests
  will just use the locally installed version.
- WASMOPTICON_DIR: <null> Path to a local clone of of the wasix-org/wasmopticon
  repository. If not specified, tests will either use a local directory if it
  exists, or clone the repository on demand.
- EDGE_SERVER: <null> Instead Edge with regular DNS resolution, test a specific
  Edge server. NOTE: currently not fully working due to deno not fully
  implementing the required Node.js APIs.

## Writing tests

Many tests create an app through the `wasmer deploy` command, and then validate
the app is running correctly on Edge.

Helper code is available to make this flow more convenient.

In particular, the `TestEnv` helper provides wrappers for executing CLI
commands, creating and deploying apps,sending queries to the backend and sending
HTTP requests to Edge.

NOTE: **You must use the TestEnv helpers to run CLI commands and to send
requests to Edge to ensure test environment settings are respected.**

### Test UATs and project structure

Each area of functionality is intended to have its own directory and pipeline step, correlating roughly with the [QA UATs](https://linear.app/wasmer/settings/teams/QA/templates).
This is to optimize each suite (allow failing fast) and to quickly highlight issue in pipeline, as well as reruns on periodic tests.

So, please place tests within the feature's respective domain.
Example: If additional functionality is added to app-jobs, either modify [the main job test file](./tests/job/job.test.ts), or write a new test file in the same directory.

If writing tests for a features within a new domain, create a new directory and be sure to add it to the [workflow](./.github/workflows/integration-test-workflow.yaml).
What constitutes a new domain?
[Noone knows!](https://redis.io/glossary/domain-driven-design-ddd/#:~:text=At%20its%20core%2C%20DDD%20is,within%20which%20the%20software%20operates.)
It's all very fluffy.
But if it feels radically different to other features (such as, Agentic Workloads vs php webserver), perhaps it's a new domain.

If you're unsure where to place a test, simply write the test as a new file and place it under `./tests/general` with a name describing the functionality (for example `volumes.test.ts`).
