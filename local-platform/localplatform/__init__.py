"""Dependency-free tooling that boots a disposable local Wasmer platform.

This package replaces the previous bash implementation (lib.sh + scripts/*.sh)
one phase per module:

- resolve:          turn BACKEND_VERSION/EDGE_VERSION selectors into concrete inputs
- fetch:            download/load the Backend image and Edge binary
- bootstrap:        generate backend/test env files and the Edge config
- ensure_compiled:  warm the Edge compiler cache for seeded packages
- up:               orchestrate the full stack boot (and reuse running stacks)
- down/logs:        teardown, log collection, and log printing
- local_test:       `make local-test` — boot, run the Jest command, report

Only the Python standard library is used. External processes (docker, gh,
node, openssl, ...) are invoked where the work genuinely lives outside Python.
"""
