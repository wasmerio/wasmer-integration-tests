.PHONY: fmt fmt-check check lint test clean all
JSPATHS = ./src ./tests ./bin

setup:
	@command -v deno >/dev/null 2>&1 || { echo >&2 "Deno is not installed. Installing..."; curl -fsSL https://deno.land/install.sh | sh; }

fmt: setup
	deno fmt $(JSPATHS)

fmt-check: setup
	deno fmt --check $(JSPATHS)

check: setup
	deno check $(JSPATHS)
	deno lint $(JSPATHS)

lint: setup fmt-check check

test: setup
	deno test --allow-all --quiet --parallel .


