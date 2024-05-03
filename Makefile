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
	@export $$(cat .env.$(TEST_ENV) | xargs) && cd packages/static-web-server && wasmer publish
	@export $$(cat .env.$(TEST_ENV) | xargs) && cd packages/test-app && wasmer publish
test: test-rust
	@export $$(cat .env.$(TEST_ENV) | xargs) && poetry run -- pytest tests -vv

test-rust:
	@export $$(cat .env.$(TEST_ENV) | xargs) && cd watest && RUST_LOG=logging=trace,info cargo test
