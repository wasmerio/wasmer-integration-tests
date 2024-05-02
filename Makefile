DEV :=

ifdef DEV
include .env.dev
TEST_ENV=dev
else
include .env.local
TEST_ENV=local
endif

setup: 
	docker-compose up -d
	poetry install
	@export $$(cat .env.$(TEST_ENV) | xargs) && wasmer config set registry.url $$WASMER_REGISTRY
	@export $$(cat .env.$(TEST_ENV) | xargs) && wasmer login $$WASMER_TOKEN
test: test-rust
	@export $$(cat .env.$(TEST_ENV) | xargs) && poetry run -- pytest tests -vv --ignore=tests/edge/test_ssh.py

test-rust:
	@export $$(cat .env.$(TEST_ENV) | xargs) && cd watest && RUST_LOG=logging=trace,info cargo test
