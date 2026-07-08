.PHONY: fmt fmt-check check lint test clean all local-test local-platform-prepare local-platform-up local-platform-down local-platform-logs local-platform-status
JSPATHS = ./src ./tests ./bin
JEST_ARGS ?=
PYTHON ?= python3
LOCAL_PLATFORM_CLI = $(PYTHON) ./local-platform/cli.py

setup:
	@node -v | awk -F. '{ if ($$1 < 22) { print "Node version 22+ is required. Please install it."; exit 1; } }'
	@pnpm install

fmt: setup
	pnpm exec prettier "**/*" --ignore-path .prettierignore --ignore-path .gitignore --write

fmt-check: setup
	pnpm exec prettier "**/*" --ignore-path .prettierignore  --ignore-path .gitignore --check

check: setup
	pnpm exec tsc --noEmit
	pnpm exec eslint $(JSPATHS)
	$(PYTHON) -m compileall -q ./local-platform/cli.py ./local-platform/localplatform
	$(PYTHON) -m unittest discover -s ./local-platform -p 'test_*.py'

lint: setup fmt-check check

test: setup
	pnpm exec jest $(JEST_ARGS)

local-test: setup
	$(LOCAL_PLATFORM_CLI) local-test

local-platform-prepare:
	$(LOCAL_PLATFORM_CLI) prepare

local-platform-up:
	$(LOCAL_PLATFORM_CLI) up

local-platform-down:
	$(LOCAL_PLATFORM_CLI) down

local-platform-logs:
	$(LOCAL_PLATFORM_CLI) logs

local-platform-status:
	$(LOCAL_PLATFORM_CLI) status
