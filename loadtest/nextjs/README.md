# Next.js load test

This executable deploys the `fixtures/nextjs/blog-load-test` Next.js app to
Wasmer Edge, load-tests every one of its routes with Artillery, then deletes
the app. It is a standalone load test and is not run by Jest.

Unlike the [WordPress load test](../wordpress/README.md), this is not a
"point at any URL" tool: WordPress crawling works because a live WordPress
site already has content and admin pages to discover. A fresh Next.js app has
neither, so this script deploys its own fixture (a small SSR "blog" with a
home page and several post pages, all rendered per-request rather than
served from a build-time cache) and knows its routes up front - no crawling,
no build-manifest parsing.

```bash
pnpm run loadtest:nextjs --concurrency 10 --count 3
```

## Flags

- `--concurrency <number>`: Concurrent Artillery virtual users. Defaults to
  `10`.
- `--count <number>`: Number of times each virtual user loads every route.
  Defaults to `1`.
- `--owner <namespace>`: Owner namespace to deploy the fixture under.
  Defaults to the namespace resolved by the `wasmer` CLI (see
  `resolveOwner` in `src/wasmer_cli.ts`).
- `-h`, `--help`: Print the command help.

Set `KEEP_APPS=1` to preserve the deployed app instead of deleting it at the
end of the run (the same convention used by the Jest test suites).

The deploy uses `wasmer deploy --build-remote`, so the fixture has no
`wasmer.toml` - the build is auto-detected and run remotely. Every crawler
and load request sends `Cache-Control: no-cache, no-store, max-age=0`;
generated Artillery input is retained in a temporary directory and its path
is logged.

To change the number or content of routes exercised, edit
`fixtures/nextjs/blog-load-test/lib/posts.ts` - it is the single source of
truth for both the fixture's pages and this script's route list.
