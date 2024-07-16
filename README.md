This repository contains integration tests. If the behaviour you want to test requires multiple components (cli, backend, edge), test goes in here.

By default, tests use the registry of your wasmer cli. So set 
`wasmer config set registry.url` to which registry you want to run the tests against. In case of prod you also need to supply DEFAULT_APP_DOMAIN="wasmer.app" to tests as enviroment variable

In general, tests create an application from an existing package, and tests the behaviour

If you want to have a package or an app present before running the tests, please create it manually and add its wasmer.toml and app.yaml files in the fixtures/ directory. This will help us track who deployed what in where

There are some utility functions in src/lib.rs, but feel free to write however you want. There is no standard/conventions yet

Feel free to ask anything!


Note: currently, dev backend has concurrency issues, so run the tests with single thread. Like `cargo test --no-fail-fast -- --test-threads 1` 