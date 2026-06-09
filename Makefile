.PHONY: fmt fmt-check check lint test clean all local-test local-platform-down local-platform-logs
JSPATHS = ./src ./tests ./bin
JEST_ARGS ?=

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

lint: setup fmt-check check

test: setup
	pnpm exec jest $(JEST_ARGS)

local-test:
	bash ./local-platform/scripts/local-test.sh

local-platform-down:
	bash ./local-platform/scripts/down.sh

local-platform-logs:
	bash ./local-platform/scripts/print-logs.sh
