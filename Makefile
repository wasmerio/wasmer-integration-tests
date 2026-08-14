# Self-locating: every recipe anchors to this file's directory, so a parent
# repo vendoring this one as a submodule imports the whole namespace with a
# two-line Makefile:
#
#   include integration-tests/Makefile
#   integration-tests/Makefile:
#   	git submodule update --init integration-tests
.PHONY: fmt fmt-check check lint test clean all ass local-test local-platform-prepare local-platform-up local-platform-down local-platform-stop local-platform-logs local-platform-status
LOCAL_PLATFORM_ROOT := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
JSPATHS = ./src ./tests ./bin ./ass
JEST_ARGS ?=
PYTHON ?= python3
LOCAL_PLATFORM_CLI = cd $(LOCAL_PLATFORM_ROOT) && $(PYTHON) ./local-platform/cli.py

setup:
	@node -v | awk -F. '{ if ($$1 < 22) { print "Node version 22+ is required. Please install it."; exit 1; } }'
	@cd $(LOCAL_PLATFORM_ROOT) && pnpm install

fmt: setup
	cd $(LOCAL_PLATFORM_ROOT) && pnpm exec prettier "**/*" --ignore-path .prettierignore --ignore-path .gitignore --write

fmt-check: setup
	cd $(LOCAL_PLATFORM_ROOT) && pnpm exec prettier "**/*" --ignore-path .prettierignore  --ignore-path .gitignore --check

check: setup
	cd $(LOCAL_PLATFORM_ROOT) && node ./bin/check-suite-coverage.mjs
	cd $(LOCAL_PLATFORM_ROOT) && pnpm exec tsc --noEmit
	cd $(LOCAL_PLATFORM_ROOT) && pnpm exec eslint $(JSPATHS)
	cd $(LOCAL_PLATFORM_ROOT) && $(PYTHON) -m compileall -q ./local-platform/cli.py ./local-platform/localplatform
	cd $(LOCAL_PLATFORM_ROOT) && $(PYTHON) -m unittest discover -s ./local-platform -p 'test_*.py'

lint: setup fmt-check check

test: setup
	cd $(LOCAL_PLATFORM_ROOT) && pnpm exec jest $(JEST_ARGS)

# Zero-config bootstrap: detects the agentic harness in use and hands it the
# setup contract. Deliberately not dependent on `setup` — it runs before the
# toolchain exists.
ass:
	@cd $(LOCAL_PLATFORM_ROOT) && sh ./ass/bootstrap/detect.sh

local-test: setup
	$(LOCAL_PLATFORM_CLI) local-test

local-platform-prepare:
	$(LOCAL_PLATFORM_CLI) prepare

local-platform-up:
	$(LOCAL_PLATFORM_CLI) up

local-platform-down:
	$(LOCAL_PLATFORM_CLI) down

# Suspend instead of destroy: containers and volumes stay, so the next
# `local-platform-up` resumes this run (migrated, bootstrapped, seeded) in
# seconds rather than rebuilding it.
local-platform-stop:
	$(LOCAL_PLATFORM_CLI) stop

local-platform-logs:
	$(LOCAL_PLATFORM_CLI) logs

local-platform-status:
	$(LOCAL_PLATFORM_CLI) status
