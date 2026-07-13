# WordPress load test

This executable crawls a same-origin WordPress site and loads every discovered
URL with Artillery. It is a standalone load test and is not run by Jest.

```bash
./loadtest/wordpress/wordpress-load-test.mjs \
  --url https://example.com \
  --concurrency 10 \
  --count 3 \
  --include-assets
```

## Flags

- `--url <url>`: Required WordPress site URL to crawl and load. It must use
  HTTP or HTTPS.
- `--concurrency <number>`: Concurrent Artillery virtual users. Defaults to
  `10`.
- `--count <number>`: Number of times each virtual user loads every discovered
  URL. Defaults to `1`.
- `--max-urls <number>`: Maximum same-origin page URLs to crawl. Defaults to
  `1000`.
- `--include-assets`: Include discovered same-origin JavaScript, stylesheets,
  and images in the load test.
- `--exclude-assets`: Exclude assets from the load test. This is the default.
- `-h`, `--help`: Print the command help.

The crawler always includes and fetches `/wp-admin/`, including it in the crawl
logs and using it to discover assets. Pages and assets are deduplicated.
Artillery reports per-URL metrics and aggregate totals. Every crawler and load
request sends `Cache-Control: no-cache, no-store, max-age=0`; generated
Artillery input is retained in a temporary directory and its path is logged.
