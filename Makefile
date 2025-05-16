.PHONY: fmt fmt-check check lint test clean all
JSPATHS = ./src ./tests ./bin

setup:
	@node -v | awk -F. '{ if ($$1 < 22) { print "Node version 22+ is required. Please install it."; exit 1; } }'
	@pnpm install
	@pnpm add -D jest

fmt: setup
	@npx prettier "**/*" --ignore-path .prettierignore --write

fmt-check: setup
	@npx prettier "**/*" --ignore-path .prettierignore --check

check: setup
	@npx tsc --noEmit 
	@npx eslint $(JSPATHS)

lint: setup fmt-check check

test: setup
	pnpm run test
