# CDN Cache Test Plan

## Goal

Add an integration test suite that proves Edge CDN caching behaves like a normal
HTTP CDN cache when an app enables:

```yaml
capabilities:
  cdn_cache:
    enabled: true
```

The suite should validate cache population, cache-key behavior, response
`Cache-Control` semantics, client request cache-control directives, and the new
app-level purge mutation.

## Schema Notes

GraphQL schema introspection on the dev registry shows the CDN-specific mutation
to use:

```graphql
mutation PurgeAppCdnCache($app: ID!) {
  purgeAppCdnCache(app: $app) {
    success
  }
}
```

Related schema:

- `configureAppCdnCache(app: ID!, config: AppCdnCacheConfigUpdate!)`
- `AppCdnCacheConfigUpdate { enabled: Boolean }`
- `purgeCacheForAppVersion` and `purgeCacheForAppVersionById` also exist, but
  the CDN suite should primarily exercise `purgeAppCdnCache` because the feature
  is configured at the app CDN cache level.

## Required Test Infrastructure Changes

1. Extend `src/app/construct.ts` so `AppCapabilities` accepts:

   ```ts
   cdn_cache: z
     .object({
       enabled: z.boolean(),
     })
     .optional(),
   ```

2. Add a CDN helper module, probably `tests/app/cdn-cache.test.ts` or
   `tests/general/cdn-cache.test.ts`. Prefer `tests/app/` because this is app
   behavior exposed through Edge.

3. Add helper functions in the test file unless reuse becomes necessary:
   - `buildCdnCacheTestApp()`: returns a `buildJsWorkerApp()` app with CDN cache
     enabled.
   - `fetchText(env, app, path, init?)`: wraps `env.fetchApp`, consumes text,
     returns `{ status, headers, body, json? }`. After one initial readiness
     request with default waiting, repeated cache probes should pass
     `noWait: true` so `fetchApp` does not turn a CDN/cache behavior check into
     an app-version readiness check. It should pass `redirect: "manual"`
     explicitly and set `noAssertSuccess: true` for expected `304`, `404`, and
     `500` responses.
   - `waitForStableCachedResponse(...)`: repeatedly requests the same URL until
     at least three consecutive responses have the same origin-generated token
     across a minimum observation window.
   - `expectNotCached(...)`: makes repeated requests and asserts origin-generated
     tokens do not stabilize over the same timeout used by positive warmup.
   - `purgeAppCdnCache(env, app)`: calls `env.backend.gqlQuery` with
     `purgeAppCdnCache`.
   - `waitForPurgeToTakeEffect(...)`: polls until a previously cached URL returns
     a different token, the old token remains absent for multiple consecutive
     polls, and the replacement token can stabilize again.

4. Always reach the app through `env.fetchApp`. Do not use raw `fetch`, because
   local Edge tests require host-header routing through `EDGE_SERVER`.

5. Always consume response bodies with `text()`/`json()` or cancel them. This is
   especially important for polling helpers and expected non-2xx/304 cases.

## Test App Fixture

Use a JavaScript worker app so each route can deliberately control headers and
body content.

Every cacheable route should return JSON with an origin-generated identity:

```json
{
  "route": "/max-age",
  "token": "crypto.randomUUID()",
  "timestamp": 1783420000000,
  "method": "GET",
  "url": "...",
  "requestHeaders": { "accept-language": "en" }
}
```

Cache hits are detected by seeing the same `token` for the same cache key.
Origin misses are detected by seeing a new `token`. This avoids depending on an
implementation-specific `x-cache` header, while still recording any such headers
in debug output when present.

Do not echo all request headers. Echo only the synthetic headers required by the
current assertion. Redact `authorization`, `cookie`, tokens, and secrets from
fixture responses and assertion diagnostics.

Suggested routes:

- `/cache/max-age`: `Cache-Control: public, max-age=120`
- `/cache/s-maxage`: `Cache-Control: public, max-age=0, s-maxage=120`
- `/cache/expires`: `Expires: <future HTTP date generated per request>`
- `/cache/no-store`: `Cache-Control: no-store`
- `/cache/private`: `Cache-Control: private, max-age=120`
- `/cache/no-cache`: `Cache-Control: no-cache, max-age=120`, fixed `ETag`
- `/cache/must-revalidate-short`: `Cache-Control: public, max-age=5, must-revalidate`, fixed `ETag`
- `/cache/vary-accept-language`: `Cache-Control: public, max-age=120`, `Vary: Accept-Language`
- `/cache/vary-authorization`: `Cache-Control: public, max-age=120`, `Vary: Authorization`
- `/cache/query`: `Cache-Control: public, max-age=120`
- `/cache/cookie`: `Cache-Control: public, max-age=120`, echoes cookies
- `/cache/status/200`: `Cache-Control: public, max-age=120`, status 200
- `/cache/status/404`: `Cache-Control: public, max-age=120`, status 404
- `/cache/status/500`: `Cache-Control: public, max-age=120`, status 500
- `/cache/head`: `Cache-Control: public, max-age=120`, supports `GET` and `HEAD`
- `/cache/post`: `Cache-Control: public, max-age=120`, echoes request body
- `/cache/etag`: `Cache-Control: public, max-age=120`, `ETag: "fixture-etag"`
- `/cache/last-modified`: `Cache-Control: public, max-age=120`, `Last-Modified: <fixed date>`

Use unique query parameters per assertion group, for example
`/cache/max-age?case=${crypto.randomUUID()}`, so tests do not share cache state.

Validator routes must implement origin-side conditional request behavior:
matching `If-None-Match` or `If-Modified-Since` returns `304` with no body;
non-matching validators return `200` with a fresh JSON token.

## CDN Policy Matrix

The CI tests should assert only policy decisions that are explicitly intended
for Wasmer Edge. Unknown or unsettled behavior should be diagnostic first, then
converted into gating assertions when the policy is finalized.

| Area                                            | Gating expectation                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability disabled                             | Do not store responses, even with cacheable origin headers.                                                                                                |
| `public, max-age`                               | Cacheable for `GET`/`HEAD` responses.                                                                                                                      |
| `s-maxage`                                      | Shared-cache `s-maxage` overrides browser `max-age`.                                                                                                       |
| `Cache-Control` vs `Expires`                    | `Cache-Control` takes precedence over `Expires`; future `Expires` is cacheable only when `Cache-Control` is absent.                                        |
| `no-store` response                             | Never stored.                                                                                                                                              |
| `private` response                              | Never stored by the shared CDN cache.                                                                                                                      |
| `no-cache` response                             | Must not be served without revalidation; if revalidation is not implemented, it must miss.                                                                 |
| Request `Cache-Control: no-cache` / `max-age=0` | Must force revalidation or bypass for that request.                                                                                                        |
| Request `Cache-Control: no-store`               | Must not store the request result; whether it bypasses an existing stored object is an Edge policy assertion and should be documented before gating.       |
| Query string                                    | Raw query string is part of the cache key unless Edge intentionally normalizes it. Query-order behavior is diagnostic until finalized.                     |
| `Vary`                                          | Named request headers are part of the cache key.                                                                                                           |
| `Authorization`                                 | Must not leak bodies across credentials. Cache misses are acceptable; caching requires explicit `public` plus correct keying or `Vary`.                    |
| `Cookie` / `Set-Cookie`                         | Must not leak user-specific bodies. `Set-Cookie` responses should not be stored unless Edge deliberately supports and documents that behavior.             |
| Unsafe methods                                  | `POST`, `PUT`, `PATCH`, and `DELETE` responses are not served from CDN cache; unsafe method invalidation policy should be tested once defined.             |
| Status codes                                    | `200` caches with explicit freshness; `404` caches only if Edge supports explicit negative caching; `500` should not cache unless that policy is explicit. |
| Validators                                      | `ETag` and `Last-Modified` conditional requests preserve HTTP semantics and use `noAssertSuccess: true` for expected `304`.                                |

## Core Test Cases

### 1. CDN Cache Is Disabled Without Capability

Deploy the same worker fixture without `capabilities.cdn_cache.enabled`.

Steps:

1. Fetch `/cache/max-age?case=<id>` several times.
2. Assert tokens keep changing.

Expected result: Edge does not cache even when the origin sends cacheable
headers unless the app capability is enabled.

### 2. CDN Cache Populates After Repeated Requests

Deploy with CDN cache enabled.

Steps:

1. Fetch `/cache/max-age?case=<id>` repeatedly.
2. Do not require the second request to be a hit.
3. Poll up to a bounded timeout, for example 30-60 seconds, until the same token
   appears in at least three consecutive responses across the minimum
   observation window.

Expected result: cache eventually populates for a cacheable response.

### 3. Cache Key Includes Path And Query

Steps:

1. Warm `/cache/query?case=<id>&value=a`.
2. Warm `/cache/query?case=<id>&value=b`.
3. Assert each URL stabilizes to its own token.
4. Refetch both URLs and assert their tokens remain distinct.

Expected result: different query strings do not collide.

### 4. Query Parameter Order Behavior

Steps:

1. Warm `/cache/query?case=<id>&a=1&b=2`.
2. Fetch `/cache/query?case=<id>&b=2&a=1`.
3. Record whether this is a hit or miss as a diagnostic.

Expected result: do not make this a gating assertion until Edge's query
normalization policy is finalized. Most CDNs treat the raw query string as part
of the cache key unless configured otherwise.

### 5. Response `Cache-Control: public, max-age`

Steps:

1. Warm `/cache/max-age?case=<id>`.
2. Assert repeated requests return the cached token before `max-age` expires.

Expected result: `public, max-age=120` is cacheable.

### 6. Response `Cache-Control: s-maxage`

Steps:

1. Warm `/cache/s-maxage?case=<id>`.
2. Assert repeated requests return the cached token even though `max-age=0`.

Expected result: shared-cache `s-maxage` controls CDN caching and overrides
browser-oriented `max-age=0`.

### 7. `Expires` Header Support

Steps:

1. Warm `/cache/expires?case=<id>`.
2. Assert repeated requests return the cached token.

Expected result: future `Expires` is cacheable when `Cache-Control` is absent.

### 8. `no-store` Is Never Cached

Steps:

1. Fetch `/cache/no-store?case=<id>` several times.
2. Assert each response has a new token.

Expected result: `Cache-Control: no-store` prevents storage.

### 9. `private` Is Not Stored By CDN

Steps:

1. Fetch `/cache/private?case=<id>` several times.
2. Assert each response has a new token.

Expected result: shared CDN cache does not store `private` responses.

### 10. `no-cache` Requires Revalidation

Steps:

1. Fetch `/cache/no-cache?case=<id>` once and record its validator and token.
2. Fetch the same URL with a matching conditional request header.
3. Accept `304 Not Modified`, or a `200 OK` response only when it carries a new
   origin token rather than the first response body.

Expected result: if Edge has revalidation support, the origin should observe
conditional requests and may return 304. If revalidation is not implemented yet,
the conservative expected behavior is a fresh miss. The fixture must include a
validator so this can be tested rather than inferred.

### 11. Expiry And Revalidation

Steps:

1. Warm `/cache/must-revalidate-short?case=<id>`.
2. Assert it is cached before the five-second TTL expires.
3. Sleep past TTL.
4. Fetch again.

Expected result: response after expiry is not the stale cached token unless Edge
has an explicit stale-serving policy. If conditional revalidation is supported,
assert `If-None-Match` or `If-Modified-Since` reaches origin. Use a TTL buffer
large enough to avoid racing the clock, and record `Date` and `Age` headers.

### 12. Client `Cache-Control: no-cache`

Steps:

1. Warm `/cache/max-age?case=<id>`.
2. Fetch the same URL with request header `Cache-Control: no-cache`.
3. Fetch again without client cache-control.

Expected result: client `no-cache` forces revalidation or bypass for that
request. The final normal request may return either the prior cached token or a
freshly revalidated token, but it must be internally consistent with Edge's
documented behavior.

### 13. Client `Cache-Control: no-store`

Steps:

1. Warm `/cache/max-age?case=<id>`.
2. Fetch with request header `Cache-Control: no-store`.
3. Fetch normally again.

Expected result: the `no-store` request is not satisfied from cache and does not
replace the cached object only if this is the intended Edge policy. The
HTTP-required assertion is narrower: the `no-store` request result must not be
stored.

### 14. Client `Cache-Control: max-age=0`

Steps:

1. Warm `/cache/max-age?case=<id>`.
2. Fetch with request header `Cache-Control: max-age=0`.

Expected result: Edge treats the request as requiring revalidation or bypass,
matching standard shared-cache semantics.

### 15. `Vary` Header Is Respected

Steps:

1. Warm `/cache/vary-accept-language?case=<id>` with `Accept-Language: en`.
2. Warm the same URL with `Accept-Language: de`.
3. Assert each variant has a stable and distinct token.
4. Fetch again with `Accept-Language: en` and get the `en` token.

Expected result: `Vary` request headers are part of the cache key.

### 16. Authorization Does Not Leak Cached Responses

Steps:

1. Fetch `/cache/vary-authorization?case=<id>` with
   `Authorization: Bearer token-a`.
2. Fetch the same URL with `Authorization: Bearer token-b`.
3. Fetch with no `Authorization`.

Expected result: responses do not leak across authorization boundaries. Make
cache misses the initial gating expectation unless Edge explicitly documents
credentialed response caching with `public` plus correct keying or `Vary`.

### 17. Cookie Handling Does Not Leak User-Specific Bodies

Steps:

1. Fetch `/cache/cookie?case=<id>` with `Cookie: user=a`.
2. Fetch the same URL with `Cookie: user=b`.

Expected result: responses do not leak across cookie values. Make cache misses
the initial gating expectation for cookie-bearing requests and `Set-Cookie`
responses unless Edge explicitly documents another policy.

### 18. Non-GET Methods Are Not Cached

Steps:

1. POST to `/cache/post?case=<id>` with body `a`.
2. POST to the same URL with body `b`.
3. Assert tokens and echoed bodies are fresh and correct.

Expected result: POST responses are not reused as CDN hits.

### 19. HEAD And GET Semantics

Steps:

1. Warm `/cache/head?case=<id>` with `GET`.
2. Request `HEAD` for the same URL.
3. Fetch `GET` again.

Expected result: `HEAD` returns headers without body and does not corrupt the
cached `GET` body. If Edge uses GET cache metadata for HEAD, assert that status
and cache headers match.

### 20. Status Code Cacheability

Steps:

1. Assert `200` with explicit `public, max-age=120` caches.
2. Assert `404` with explicit `public, max-age=120` caches if Edge supports
   negative caching with explicit headers.
3. Assert `500` is not cached even if it carries cacheable headers, unless Edge
   intentionally follows header-driven caching for 5xx.

Expected result: status handling matches documented CDN policy and does not
cache transient server errors unintentionally. Use `noAssertSuccess: true` for
expected `404` and `500` responses so the test harness does not treat them as
deployment/readiness failures.

### 21. Conditional Requests With ETag

Steps:

1. Fetch `/cache/etag?case=<id>` and record `ETag`.
2. Fetch with `If-None-Match` matching that ETag.
3. Fetch with `If-None-Match` not matching that ETag.

Expected result: Edge preserves correct conditional request semantics. A cached
object may produce `304` for a matching validator; non-matching validators must
not incorrectly return stale content. Use `noAssertSuccess: true` for expected
`304` responses.

### 22. Conditional Requests With Last-Modified

Steps:

1. Fetch `/cache/last-modified?case=<id>` and record `Last-Modified`.
2. Fetch with `If-Modified-Since` equal to that value.

Expected result: Edge handles `Last-Modified` validators correctly, either by
responding from cache with `304` or by forwarding and preserving origin
semantics. Use `noAssertSuccess: true` for expected `304` responses.

## Purge Test Cases

### 23. App-Level Purge Eventually Evicts Cached Objects

Steps:

1. Warm two independent URLs:
   - `/cache/max-age?case=<id>&item=a`
   - `/cache/max-age?case=<id>&item=b`
2. Record their stable cached tokens.
3. Call `purgeAppCdnCache(app.id)`.
4. Poll both URLs until each returns a token different from the pre-purge token.
5. Continue polling until the old token stays absent for several consecutive
   polls and the replacement token stabilizes.

Expected result: purge succeeds and cached objects stop being served after a
bounded propagation delay.

### 24. Purge Does Not Break Future Cache Population

Steps:

1. Continue from the purge test after new tokens appear.
2. Keep fetching the same URL until it stabilizes again.

Expected result: purge evicts existing entries, but the CDN can cache fresh
responses afterward.

### 25. Purge Is Scoped To The App

Steps:

1. Deploy two CDN-enabled apps with the same route paths.
2. Warm both apps.
3. Purge app A.
4. Assert app A eventually changes token.
5. Assert app B continues serving its pre-purge cached token.

Expected result: app-level purge does not flush unrelated apps.

### 26. Purge Is Idempotent

Steps:

1. Call `purgeAppCdnCache(app.id)` twice.
2. Assert both mutations return `success: true`.
3. Assert the app remains reachable and cache can populate.

Expected result: repeated purges are safe.

## Deployment And Configuration Tests

### 27. Capability Enables CDN At Deploy Time

Steps:

1. Deploy with `capabilities.cdn_cache.enabled: true`.
2. Run the population test.

Expected result: app YAML capability is sufficient to enable CDN caching.

### 28. GraphQL Toggle Can Enable CDN Cache

Steps:

1. Deploy without CDN cache capability.
2. Confirm cache does not populate.
3. Call `configureAppCdnCache(app: app.id, config: { enabled: true })`.
4. Poll with fresh cache keys until the config change is visible through Edge.
5. Fetch until cache populates.

Expected result: backend configuration path enables the same Edge behavior.

### 29. GraphQL Toggle Can Disable CDN Cache

Steps:

1. Deploy or configure with CDN cache enabled.
2. Confirm cache populates.
3. Call `configureAppCdnCache(app: app.id, config: { enabled: false })`.
4. Purge the app cache to remove old objects.
5. Poll with fresh cache keys until the config change is visible through Edge.
6. Assert repeated requests do not populate the CDN cache.

Expected result: disabling CDN cache prevents new cache hits.

Config tests should first confirm the current registry exposes
`configureAppCdnCache` and `purgeAppCdnCache`. If an explicitly known
unsupported local platform target does not expose those mutations yet, skip only
the config/purge tests with a clear message rather than failing unrelated cache
semantics tests. Default/dev registries should fail when required CDN cache
mutations are absent.

## Observability And Debugging

For every failed cache assertion, include:

- app id and app URL
- route and query string
- request headers used by the assertion
- response status
- response headers, especially any `cache-control`, `age`, `etag`,
  `last-modified`, `vary`, `x-cache`, `cf-cache-status`, or Edge-specific cache
  headers
- observed token sequence

The tests should not require a specific debug cache header to pass. Header checks
can be added as soft diagnostics unless Edge documents stable cache status
headers.

Diagnostics must redact `authorization`, `cookie`, tokens, and secrets. Prefer
logging synthetic labels such as `auth-variant=a` rather than raw header values.

## Timing Guidance

Caching may not happen after a single request, and purge has propagation delay.
Use bounded polling instead of fixed assumptions:

- cache warmup timeout: 30-60 seconds
- purge propagation timeout: 60-120 seconds
- minimum stable-hit observation: at least three consecutive matching tokens
  over multiple poll intervals
- negative-cache observation: use the same timeout window as positive cache
  warmup and fail if a token stabilizes
- poll interval: 500-2000 ms with debug logging under `VERBOSE=true`

Use unique cache keys for every test case to avoid inter-test contamination.
Avoid `test.concurrent` for tests sharing the same app unless each assertion uses
unique URLs and the purge tests are isolated.

Split implementation into runtime tiers:

- Smoke suite: capability disabled, `public, max-age`, `no-store`, query key
  separation, and app-level purge.
- Extended semantics suite: `s-maxage`, `Expires`, `Vary`, client
  cache-control, validators, cookies, authorization, methods, and status-code
  matrix.
- Config suite: GraphQL enable/disable and idempotent purge behavior.

Set an explicit Jest timeout for CDN suites. The smoke suite should fit normal
CI, while extended/config suites may need a longer timeout or separate CI job.
Avoid landing all 29 cases as always-on CI in one step.

## Recommended Initial Implementation Order

1. Add `cdn_cache` to the `AppCapabilities` zod schema.
2. Add the JavaScript worker CDN fixture.
3. Implement helpers for token extraction, warmup polling, and purge mutation.
4. Land the core positive/negative cache tests:
   - disabled capability does not cache
   - `public, max-age` eventually caches
   - `no-store`, `private`, and non-GET do not cache
   - query string separation
5. Add purge tests.
6. Add full HTTP semantics coverage for `s-maxage`, `Expires`, `Vary`,
   conditional requests, client cache-control, status codes, cookies, and
   authorization.

This order gives an early signal that the feature is wired end-to-end before
adding the more nuanced HTTP cache behavior matrix.
