JSPATHS = ./src ./tests ./bin

fmt:
	deno fmt $(JSPATHS)


fmt-check:
	deno fmt --check $(JSPATHS)

check:
	deno check $(JSPATHS)
	deno lint $(JSPATHS)

lint: fmt-check check

test:
	DENO_JOBS=8 deno test --allow-all --quiet --parallel .


.PHONY: fmt fmt-check check lint
