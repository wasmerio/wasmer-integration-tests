.PHONY: fmt fmt-check check lint test clean all
JSPATHS = ./src ./tests ./bin

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
	pnpm run test
