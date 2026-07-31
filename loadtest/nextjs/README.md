# Next.js load test

Two standalone load tests for the `fixtures/nextjs/blog-load-test` Next.js
app, load-testing every one of its routes with Artillery. Neither is run by
Jest.

Unlike the [WordPress load test](../wordpress/README.md), these are not
"point at any URL" tools: WordPress crawling works because a live WordPress
site already has content and admin pages to discover. A fresh Next.js app has
neither, so both scripts build their own fixture (a small SSR "blog" with a
home page and several post pages, all rendered per-request rather than
served from a build-time cache) and know its routes up front - no crawling,
no build-manifest parsing (see `fixtures/nextjs/blog-load-test/lib/posts.ts`,
the single source of truth for both the fixture's pages and both scripts'
route list).

## Edge variant: `nextjs-load-test.ts`

Deploys the fixture to Wasmer Edge with `wasmer deploy --build-remote`,
load-tests it, then deletes the app.

```bash
pnpm run loadtest:nextjs --concurrency 10 --count 3
```

### Flags

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
`wasmer.toml` - the build is auto-detected and run remotely.

## Local variant: `nextjs-load-test-local.ts`

Runs the same fixture locally with `wasmer run` instead of deploying it, so
the running instance's own process memory can be read directly with `ps` -
no Edge deployment, no HTTP diagnostic endpoint needed. This is the simpler
option if you're specifically trying to observe memory growth (e.g. chasing
a suspected leak) rather than validating behavior under Edge's actual
hosting environment. Requires `docker` on PATH, in addition to
`nextjs-load-test.ts`'s requirements.

```bash
pnpm run loadtest:nextjs:local --concurrency 10 --count 3
```

### Flags

- `--concurrency <number>`: Concurrent Artillery virtual users. Defaults to
  `10`.
- `--count <number>`: Number of times each virtual user loads every route.
  Defaults to `1`.
- `-h`, `--help`: Print the command help.

### Why this exists: reproducing edgejs's known wasm-bindgen leak

edgejs's own `plans/eco-394-externref-*.md` docs describe a real, known
memory leak: every JS object passed across a wasm-bindgen module's externref
boundary pins a `napi_ref` for the life of the process (edgejs's
`StoreObjects` is append-only, with no removal API). Plain Next.js SSR never
crosses that boundary - `@next/swc-wasm-nodejs` (Next's own wasm-bindgen
dependency) is a **build-time** tool, and both this fixture's build and
edgejs's own test harness deliberately build on host Node.js so native SWC
runs instead, never touching the wasm-bindgen path at request-serving time
under edgejs.

**Prisma 7's driver-adapter query engine (`engineType = "client"`) is
different: it's a wasm-bindgen module invoked on every query**, matching the
docs' own repro pattern ("a hot server (Prisma query per request) grows
without bound"). So the fixture has a `/api/hit` route
(`fixtures/nextjs/blog-load-test/src/app/api/hit/route.ts`) that calls
Prisma once per request, backed by a throwaway Postgres container this
script starts and migrates automatically (via `prisma db push`) before
building.

The local variant runs **two** Artillery phases against the same running
instance so the DB route's contribution can be isolated from ordinary
request-handling noise: the plain SSR routes first (control group), then
`/api/hit` alone, RSS-sampling with `ps` after each phase.

Sample output (`--concurrency 5 --count 3`):

```
Verified http://127.0.0.1:34209/ is serving (status 200)
Memory baseline:               361.2 MB (RSS)
...
Memory after plain-SSR load:   370.2 MB (RSS)  [delta 9.0 MB]
...
Memory after Prisma-route load: 427.3 MB (RSS)  [delta 57.1 MB]
```

78 plain SSR requests grow RSS by single-digit MB (noise); 15 requests to
`/api/hit` alone grew it by tens to hundreds of MB across different runs
(delta is not linear/consistent between runs - matches the leak docs' own
description of unbounded, non-plateauing growth). To change what
`PageView.create` looks like, edit `fixtures/nextjs/blog-load-test/prisma/schema.prisma`
and `lib/db.ts`.

### How it works

The base fixture has no `wasmer.toml` (the Edge variant relies on
`--build-remote`'s auto-detection instead), so this script builds one in a
scratch copy of the fixture:

1. A throwaway Postgres container (`docker run postgres:16-alpine`),
   migrated with `prisma db push`.
2. `pnpm install`, `prisma generate`, then `pnpm dlx next-bundle@1.0.0` - the
   same bundler Wasmer's remote build pipeline uses - to produce a
   self-contained `.next-bundle/server.mjs`. The fixture forces a webpack
   build (`next build --webpack` in `package.json`); Next 16's default
   Turbopack output uses a bundler-internal "external module" reference for
   `serverExternalPackages` that `next-bundle`'s standalone execution model
   can't resolve at runtime, so Prisma's route 500s under Turbopack output
   but works under webpack.
3. A `wasmer.toml` declaring a dependency on `wasmer/edgejs-quickjs` (the
   runtime confirmed by inspecting an actual `--build-remote` deploy's
   output), mounting `.next-bundle` at `/app`, and running `/app/server.mjs`.
4. `wasmer run . --net`, verified serving with one request, then RSS-sampled
   (via `ps`) around each of the two Artillery phases. Both the `wasmer run`
   process and the Postgres container are torn down afterward.

Every load request sends `Cache-Control: no-cache, no-store, max-age=0`;
generated Artillery input and the scratch build directory are retained
(their paths are logged) rather than cleaned up, so they can be inspected
after a run.
