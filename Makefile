DEV :=

ifdef DEV
include .env.dev
SETUP_PREREQ=setup-wasmer build install-fixtures
TEST_ENV=dev
else
include .env.local
SETUP_PREREQ=pre-setup-checks install-python-depenencies up wait-for-edge wait-for-backend setup-wasmer install-fixtures
TEST_ENV=local
endif

EDGE_SCHEME ?= "http"
EDGE_HOST ?= "127.0.0.1"
EDGE_PORT ?= 80
EDGE_URL ?= $(EDGE_SCHEME)://$(EDGE_HOST):$(EDGE_PORT)

REGISTRY_SCHEME ?= "http"
REGISTRY_HOST ?= "localhost"
REGISTRY_PORT ?= 8080

REGISTRY_ENDPOINT ?= "/graphql"
REGISTRY ?= $(REGISTRY_SCHEME)://$(REGISTRY_HOST):$(REGISTRY_PORT)$(REGISTRY_ENDPOINT)
WASMER_REGISTRY ?= $(REGISTRY_SCHEME)://$(REGISTRY_HOST):$(REGISTRY_PORT)$(REGISTRY_ENDPOINT)
TOKEN ?= "wap_default_token"
WASMER_TOKEN ?= "wap_default_token"
BYPASS_EDGE ?=
BYPASS_SWE ?=


all: setup

test: test-rust
	@export $$(cat .env.$(TEST_ENV) | xargs) && poetry run -- pytest tests -vv

test-rust:
	@export $$(cat .env.$(TEST_ENV) | xargs) && cd watest && RUST_LOG=logging=trace,info cargo test


setup: $(SETUP_PREREQ)
	@echo "both backend and edge are up, and wasmer is configured to use the local registry"
	@echo "Also, the test-app is deployed and ready to be used"
	@echo "You can now run 'make logs' to see the logs from Edge and the backend"
	@echo "You can now run 'curl -H \"Host: test-app.wasmer.app\" localhost:80' to see the test-app running."

pre-setup-checks:
	@echo "Checking if docker is installed..."
	@docker --version
	@echo "Checking if docker-compose is installed..."
	@docker-compose --version
	@echo "Checking if wasmer is installed..."
	@wasmer --version

install-python-depenencies:
	@echo "Installing python dependencies..."
	poetry install

setup-wasmer:
	@echo 'Setting up wasmer to use the registry specified by $$REGISTRY with token specified by $$TOKEN'
	@wasmer config set registry.url $(REGISTRY)
	@wasmer login $(TOKEN)
	@wasmer whoami

build: setup-wasmer install-python-depenencies
	poetry run ./scripts/build.py

clear:
	poetry run ./scripts/clear.py

install-static-web-server:
ifndef BYPASS_SWE
	@echo "publishing static-web-server..."
	@(cd packages/static-web-server && \
	  wasmer publish --wait --timeout 300s --registry $(REGISTRY) --token $(TOKEN) || true)
	@echo "setup static-web-server complete"
else
	@echo "Not publishing static-web-server because BYPASS_SWE was set."
endif


install-test-app: install-static-web-server
	@echo "publishing test-app..."
	@(cd packages/test-app && \
	  wasmer publish --wait --timeout 300s --registry $(REGISTRY) --token $(TOKEN)|| true)

	@echo "deploying test-app..."
	@(cd packages/test-app && \
	  wasmer deploy --non-interactive --no-persist-id --no-wait --registry $(REGISTRY) --token $(TOKEN) || true)
	@echo "test-app deployed!"

ifndef BYPASS_EDGE
	@echo "waiting for the first response from edge for test-app (this may take a while)..."
	@curl --retry 5 --retry-all-errors -vvv -f -H "Host: test-app-cypress1.wasmer.app" $(EDGE_URL)
	@echo "test-app is up!"
endif

install-wasix-echo-server: install-static-web-server
	@echo "publishing wasix-echo-server..."
	@(cd packages/wasix-echo-server && \
	  wasmer publish --wait --timeout 600s --registry $(REGISTRY) --token $(TOKEN) || true)

	@echo "deploying wasix-echo-server..."
	@(cd packages/wasix-echo-server && \
	  wasmer deploy -v --non-interactive --no-persist-id --no-wait --registry $(REGISTRY) --token $(TOKEN) || true)
	@echo "wasix-echo-server deployed!"

ifndef BYPASS_EDGE
	@echo "waiting for the first response from edge for test-app (this may take a while)..."
	@curl --retry 5 --retry-all-errors -vvv -f -H "Host: wasix-echo-server-cypress1.wasmer.app" $(EDGE_URL)
	@echo "wasix-echo-server is up!"
endif

install-fixtures: install-test-app install-wasix-echo-server

run:
	docker-compose up

up:
	docker-compose up -d

down:
	docker-compose down


wait-for-backend:
	@echo "Waiting for backend to start..."
	@while ! nc -z $(REGISTRY_HOST) $(REGISTRY_PORT); do sleep 1; done
	@echo "Waiting for backend to start accepting queries (this may take a while)..."
	@echo "You can run 'make logs' to see the logs of the edge and backend"
	@while ! curl -fs $(REGISTRY) --max-time 10 > /dev/null; do sleep 1; done # connect-timeout is needed, because when backend starts, first curl request gets stuck
	@echo "Backend is up!"

wait-for-edge:
	@echo "Waiting for edge to start..."
	@while ! nc -z $(EDGE_HOST) $(EDGE_PORT); do sleep 1; done
	@echo "Edge started"

logs:
	docker-compose logs -f

format:
	poetry run black -- ./tests

# Alias for format
fmt: format
