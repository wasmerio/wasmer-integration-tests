import { AppInfo, buildJsWorkerApp, sleep, TestEnv } from "../../src";
import type { AppDefinition } from "../../src/app/construct";
import type { AppFetchOptions } from "../../src/env";

jest.setTimeout(180_000);

const CACHE_WARMUP_TIMEOUT_MS = 15_000;
const NEGATIVE_CACHE_TIMEOUT_MS = 3_000;
const PURGE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
const STABLE_RESPONSE_COUNT = 2;

type CdnFixtureBody = {
  route: string;
  token: string;
  timestamp: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string | null>;
  authorizationVariant?: string;
  cookieVariant?: string;
  body?: string;
};

type FetchTextResult = {
  status: number;
  headers: Headers;
  body: string;
  json?: CdnFixtureBody;
};

type StableResponse = {
  token: string;
  observations: FetchTextResult[];
};

function buildCdnCacheTestApp(cdnCacheEnabled: boolean): AppDefinition {
  const app = buildJsWorkerApp(`
const FIXED_ETAG = '"fixture-etag"';
const FIXED_LAST_MODIFIED = 'Wed, 21 Oct 2015 07:28:00 GMT';

function selectedRequestHeaders(request, names) {
  const out = {};
  for (const name of names) {
    out[name.toLowerCase()] = request.headers.get(name);
  }
  return out;
}

function authorizationVariant(request) {
  const authorization = request.headers.get("authorization");
  if (authorization === "Bearer token-a") return "a";
  if (authorization === "Bearer token-b") return "b";
  if (authorization) return "other";
  return "none";
}

function cookieVariant(request) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\\s*)user=([^;]+)/);
  return match ? match[1] : "none";
}

async function jsonResponse(request, route, init = {}) {
  const body = await request.clone().text();
  const payload = {
    route,
    token: crypto.randomUUID(),
    timestamp: Date.now(),
    method: request.method,
    url: request.url,
    requestHeaders: selectedRequestHeaders(request, [
      "accept-language",
      "cache-control",
      "if-none-match",
      "if-modified-since",
    ]),
    authorizationVariant: authorizationVariant(request),
    cookieVariant: cookieVariant(request),
  };
  if (body) {
    payload.body = body;
  }

  return new Response(request.method === "HEAD" ? null : JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

async function handler(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/cache/max-age" || path === "/cache/query") {
    return jsonResponse(request, path, {
      headers: { "cache-control": "public, max-age=120" },
    });
  }

  if (path === "/cache/s-maxage") {
    return jsonResponse(request, path, {
      headers: { "cache-control": "public, max-age=0, s-maxage=120" },
    });
  }

  if (path === "/cache/expires") {
    const expires = new Date(Date.now() + 120_000).toUTCString();
    return jsonResponse(request, path, {
      headers: { expires },
    });
  }

  if (path === "/cache/no-store") {
    return jsonResponse(request, path, {
      headers: { "cache-control": "no-store" },
    });
  }

  if (path === "/cache/private") {
    return jsonResponse(request, path, {
      headers: { "cache-control": "private, max-age=120" },
    });
  }

  if (path === "/cache/no-cache") {
    if (request.headers.get("if-none-match") === FIXED_ETAG) {
      return new Response(null, {
        status: 304,
        headers: {
          "cache-control": "no-cache, max-age=120",
          etag: FIXED_ETAG,
        },
      });
    }

    return jsonResponse(request, path, {
      headers: {
        "cache-control": "no-cache, max-age=120",
        etag: FIXED_ETAG,
      },
    });
  }

  if (path === "/cache/must-revalidate-short") {
    if (request.headers.get("if-none-match") === FIXED_ETAG) {
      return new Response(null, {
        status: 304,
        headers: {
          "cache-control": "public, max-age=5, must-revalidate",
          etag: FIXED_ETAG,
        },
      });
    }

    return jsonResponse(request, path, {
      headers: {
        "cache-control": "public, max-age=5, must-revalidate",
        etag: FIXED_ETAG,
      },
    });
  }

  if (path === "/cache/vary-accept-language") {
    return jsonResponse(request, path, {
      headers: {
        "cache-control": "public, max-age=120",
        vary: "Accept-Language",
      },
    });
  }

  if (path === "/cache/vary-authorization") {
    return jsonResponse(request, path, {
      headers: {
        "cache-control": "public, max-age=120",
        vary: "Authorization",
      },
    });
  }

  if (path === "/cache/cookie") {
    return jsonResponse(request, path, {
      headers: {
        "cache-control": "public, max-age=120",
        vary: "Cookie",
      },
    });
  }

  if (path === "/cache/set-cookie") {
    return jsonResponse(request, path, {
      headers: {
        "cache-control": "public, max-age=120",
        "set-cookie": "cdn-cache-fixture=1; Path=/; HttpOnly",
      },
    });
  }

  if (path === "/cache/status/200") {
    return jsonResponse(request, path, {
      headers: { "cache-control": "public, max-age=120" },
    });
  }

  if (path === "/cache/status/404") {
    return jsonResponse(request, path, {
      status: 404,
      headers: { "cache-control": "public, max-age=120" },
    });
  }

  if (path === "/cache/status/500") {
    return jsonResponse(request, path, {
      status: 500,
      headers: { "cache-control": "public, max-age=120" },
    });
  }

  if (path === "/cache/post") {
    return jsonResponse(request, path, {
      headers: { "cache-control": "public, max-age=120" },
    });
  }

  if (path === "/cache/etag") {
    if (request.headers.get("if-none-match") === FIXED_ETAG) {
      return new Response(null, {
        status: 304,
        headers: {
          "cache-control": "public, max-age=120",
          etag: FIXED_ETAG,
        },
      });
    }

    return jsonResponse(request, path, {
      headers: {
        "cache-control": "public, max-age=120",
        etag: FIXED_ETAG,
      },
    });
  }

  if (path === "/cache/last-modified") {
    if (request.headers.get("if-modified-since") === FIXED_LAST_MODIFIED) {
      return new Response(null, {
        status: 304,
        headers: {
          "cache-control": "public, max-age=120",
          "last-modified": FIXED_LAST_MODIFIED,
        },
      });
    }

    return jsonResponse(request, path, {
      headers: {
        "cache-control": "public, max-age=120",
        "last-modified": FIXED_LAST_MODIFIED,
      },
    });
  }

  return new Response("not found", { status: 404 });
}

addEventListener("fetch", (fetchEvent) => {
  fetchEvent.respondWith(handler(fetchEvent.request));
});
`);

  if (cdnCacheEnabled) {
    app.appYaml.capabilities = {
      ...app.appYaml.capabilities,
      cdn_cache: { enabled: true },
    };
  }

  return app;
}

function uniquePath(path: string): string {
  const joiner = path.includes("?") ? "&" : "?";
  return `${path}${joiner}case=${crypto.randomUUID()}`;
}

function cacheDebugHeaders(headers: Headers): Record<string, string> {
  const names = [
    "age",
    "cache-control",
    "cf-cache-status",
    "content-type",
    "date",
    "etag",
    "expires",
    "last-modified",
    "vary",
    "x-cache",
    "x-cache-status",
    "x-served-by",
  ];
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) {
      out[name] = value;
    }
  }
  return out;
}

function observationTokens(observations: FetchTextResult[]): string[] {
  return observations.map(
    (observation) => observation.json?.token ?? "NO_TOKEN",
  );
}

function diagnosticContext(
  app: AppInfo,
  path: string,
  observations: FetchTextResult[],
): string {
  const last = observations.at(-1);
  return JSON.stringify(
    {
      appId: app.id,
      appUrl: app.url,
      path,
      tokens: observationTokens(observations),
      lastStatus: last?.status,
      lastHeaders: last ? cacheDebugHeaders(last.headers) : {},
    },
    null,
    2,
  );
}

async function fetchText(
  env: TestEnv,
  app: AppInfo,
  path: string,
  init: AppFetchOptions = {},
): Promise<FetchTextResult> {
  const response = await env.fetchApp(app, path, {
    redirect: "manual",
    noAssertSuccess: true,
    noWait: true,
    ...init,
  });
  const body = await response.text();
  let json: CdnFixtureBody | undefined;

  if (body) {
    try {
      json = JSON.parse(body) as CdnFixtureBody;
    } catch {
      json = undefined;
    }
  }

  return {
    status: response.status,
    headers: response.headers,
    body,
    json,
  };
}

async function waitForStableCachedResponse(
  env: TestEnv,
  app: AppInfo,
  path: string,
  init: AppFetchOptions = {},
): Promise<StableResponse> {
  const observations: FetchTextResult[] = [];
  let consecutive = 0;
  let lastToken: string | undefined;
  const start = Date.now();

  while (Date.now() - start < CACHE_WARMUP_TIMEOUT_MS) {
    const result = await fetchText(env, app, path, init);
    observations.push(result);

    const token = result.json?.token;
    expect(token).toBeDefined();
    if (token && token === lastToken) {
      consecutive++;
    } else {
      lastToken = token;
      consecutive = 1;
    }

    if (token && consecutive >= STABLE_RESPONSE_COUNT) {
      return { token, observations };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Expected CDN response to stabilize.\n${diagnosticContext(
      app,
      path,
      observations,
    )}`,
  );
}

async function expectNotCached(
  env: TestEnv,
  app: AppInfo,
  path: string,
  init: AppFetchOptions = {},
): Promise<void> {
  const observations: FetchTextResult[] = [];
  let consecutive = 0;
  let lastToken: string | undefined;
  const start = Date.now();

  while (Date.now() - start < NEGATIVE_CACHE_TIMEOUT_MS) {
    const result = await fetchText(env, app, path, init);
    observations.push(result);

    const token = result.json?.token;
    expect(token).toBeDefined();
    if (token && token === lastToken) {
      consecutive++;
    } else {
      lastToken = token;
      consecutive = 1;
    }

    if (consecutive >= STABLE_RESPONSE_COUNT) {
      throw new Error(
        `Expected response not to be cached, but token stabilized.\n${diagnosticContext(
          app,
          path,
          observations,
        )}`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function mutationExists(
  env: TestEnv,
  mutationName: string,
): Promise<boolean> {
  const response = await env.backend.gqlQuery<{
    __schema: { mutationType: { fields: { name: string }[] } | null };
  }>(`
    query CdnCacheMutationSupport {
      __schema {
        mutationType {
          fields {
            name
          }
        }
      }
    }
  `);

  return (
    response.data?.__schema.mutationType?.fields.some(
      (field) => field.name === mutationName,
    ) ?? false
  );
}

async function purgeAppCdnCache(env: TestEnv, app: AppInfo): Promise<void> {
  const response = await env.backend.gqlQuery<{
    purgeAppCdnCache: { success: boolean };
  }>(
    `
      mutation PurgeAppCdnCache($app: ID!) {
        purgeAppCdnCache(app: $app) {
          success
        }
      }
    `,
    { app: app.id },
  );

  expect(response.data?.purgeAppCdnCache.success).toBe(true);
}

async function waitForPurgeToTakeEffect(
  env: TestEnv,
  app: AppInfo,
  path: string,
  oldToken: string,
): Promise<StableResponse> {
  const observations: FetchTextResult[] = [];
  let replacementToken: string | undefined;
  let consecutiveReplacement = 0;
  let consecutiveWithoutOld = 0;
  const start = Date.now();

  while (Date.now() - start < PURGE_TIMEOUT_MS) {
    const result = await fetchText(env, app, path);
    observations.push(result);

    const token = result.json?.token;
    expect(token).toBeDefined();
    if (token === oldToken) {
      replacementToken = undefined;
      consecutiveReplacement = 0;
      consecutiveWithoutOld = 0;
    } else if (token) {
      consecutiveWithoutOld++;
      if (token === replacementToken) {
        consecutiveReplacement++;
      } else {
        replacementToken = token;
        consecutiveReplacement = 1;
      }
    }

    if (
      replacementToken &&
      consecutiveWithoutOld >= STABLE_RESPONSE_COUNT &&
      consecutiveReplacement >= STABLE_RESPONSE_COUNT
    ) {
      return { token: replacementToken, observations };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Expected CDN purge to evict old token ${oldToken}.\n${diagnosticContext(
      app,
      path,
      observations,
    )}`,
  );
}

describe("app CDN cache smoke", () => {
  test("cdn cache is disabled without capability", async () => {
    const env = TestEnv.fromEnv();
    const app = await env.deployApp(buildCdnCacheTestApp(false));

    try {
      await expectNotCached(env, app, uniquePath("/cache/max-age"));
    } finally {
      await env.deleteApp(app);
    }
  });

  test("cdn cache honors HTTP semantics, purge, and cache key isolation", async () => {
    const env = TestEnv.fromEnv();
    const app = await env.deployApp(buildCdnCacheTestApp(true));

    try {
      const [maxAge, sMaxage, expires] = await Promise.all([
        waitForStableCachedResponse(env, app, uniquePath("/cache/max-age")),
        waitForStableCachedResponse(env, app, uniquePath("/cache/s-maxage")),
        waitForStableCachedResponse(env, app, uniquePath("/cache/expires")),
      ]);
      expect(maxAge.token).toBeDefined();
      expect(sMaxage.token).toBeDefined();
      expect(expires.token).toBeDefined();

      await Promise.all([
        expectNotCached(env, app, uniquePath("/cache/no-store")),
        expectNotCached(env, app, uniquePath("/cache/private")),
        expectNotCached(env, app, uniquePath("/cache/no-cache")),
        expectNotCached(env, app, uniquePath("/cache/post"), {
          method: "POST",
          body: "post-body",
        }),
      ]);

      const queryCase = crypto.randomUUID();
      const queryAPath = `/cache/query?case=${queryCase}&value=a`;
      const queryBPath = `/cache/query?case=${queryCase}&value=b`;
      const [queryA, queryB] = await Promise.all([
        waitForStableCachedResponse(env, app, queryAPath),
        waitForStableCachedResponse(env, app, queryBPath),
      ]);

      expect(queryA.token).not.toBe(queryB.token);

      const [queryAAgain, queryBAgain] = await Promise.all([
        fetchText(env, app, queryAPath),
        fetchText(env, app, queryBPath),
      ]);
      expect(queryAAgain.json?.token).toBe(queryA.token);
      expect(queryBAgain.json?.token).toBe(queryB.token);

      const languagePath = `/cache/vary-accept-language?case=${crypto.randomUUID()}`;
      const [english, german] = await Promise.all([
        waitForStableCachedResponse(env, app, languagePath, {
          headers: { "accept-language": "en" },
        }),
        waitForStableCachedResponse(env, app, languagePath, {
          headers: { "accept-language": "de" },
        }),
      ]);

      expect(english.token).not.toBe(german.token);

      const englishAgain = await fetchText(env, app, languagePath, {
        headers: { "accept-language": "en" },
      });
      expect(englishAgain.json?.token).toBe(english.token);
      expect(englishAgain.json?.requestHeaders["accept-language"]).toBe("en");

      const etagPath = uniquePath("/cache/etag");
      const etagInitial = await fetchText(env, app, etagPath);
      expect(etagInitial.status).toBe(200);
      const etag = etagInitial.headers.get("etag");
      expect(etag).toBe('"fixture-etag"');

      const etagMatched = await fetchText(env, app, etagPath, {
        headers: { "if-none-match": etag ?? "" },
      });
      expect(etagMatched.status).toBe(304);
      expect(etagMatched.body).toBe("");

      const etagMiss = await fetchText(env, app, etagPath, {
        headers: { "if-none-match": '"not-the-fixture-etag"' },
      });
      expect(etagMiss.status).toBe(200);
      expect(etagMiss.json?.token).toBeDefined();

      const lastModifiedPath = uniquePath("/cache/last-modified");
      const lastModifiedInitial = await fetchText(env, app, lastModifiedPath);
      expect(lastModifiedInitial.status).toBe(200);
      const lastModified = lastModifiedInitial.headers.get("last-modified");
      expect(lastModified).toBe("Wed, 21 Oct 2015 07:28:00 GMT");

      const lastModifiedMatched = await fetchText(env, app, lastModifiedPath, {
        headers: { "if-modified-since": lastModified ?? "" },
      });
      expect(lastModifiedMatched.status).toBe(304);
      expect(lastModifiedMatched.body).toBe("");

      const noCachePath = uniquePath("/cache/max-age");
      const maxAgeZeroPath = uniquePath("/cache/max-age");
      const [cachedForNoCache, cachedForMaxAgeZero] = await Promise.all([
        waitForStableCachedResponse(env, app, noCachePath),
        waitForStableCachedResponse(env, app, maxAgeZeroPath),
      ]);
      const [noCache, maxAgeZero] = await Promise.all([
        fetchText(env, app, noCachePath, {
          headers: { "cache-control": "no-cache" },
        }),
        fetchText(env, app, maxAgeZeroPath, {
          headers: { "cache-control": "max-age=0" },
        }),
      ]);
      expect(noCache.json?.token).toBeDefined();
      expect(noCache.json?.token).not.toBe(cachedForNoCache.token);
      expect(maxAgeZero.json?.token).toBeDefined();
      expect(maxAgeZero.json?.token).not.toBe(cachedForMaxAgeZero.token);

      const noStorePath = uniquePath("/cache/max-age");
      const noStore = await fetchText(env, app, noStorePath, {
        headers: { "cache-control": "no-store" },
      });
      const afterNoStore = await fetchText(env, app, noStorePath);
      expect(noStore.json?.token).toBeDefined();
      expect(afterNoStore.json?.token).toBeDefined();
      expect(afterNoStore.json?.token).not.toBe(noStore.json?.token);

      const authPath = uniquePath("/cache/vary-authorization");
      for (let i = 0; i < STABLE_RESPONSE_COUNT; i++) {
        const authA = await fetchText(env, app, authPath, {
          headers: { authorization: "Bearer token-a" },
        });
        const authB = await fetchText(env, app, authPath, {
          headers: { authorization: "Bearer token-b" },
        });
        const authNone = await fetchText(env, app, authPath);

        expect(authA.json?.authorizationVariant).toBe("a");
        expect(authB.json?.authorizationVariant).toBe("b");
        expect(authNone.json?.authorizationVariant).toBe("none");
      }

      const cookiePath = uniquePath("/cache/cookie");
      for (let i = 0; i < STABLE_RESPONSE_COUNT; i++) {
        const cookieA = await fetchText(env, app, cookiePath, {
          headers: { cookie: "user=a" },
        });
        const cookieB = await fetchText(env, app, cookiePath, {
          headers: { cookie: "user=b" },
        });
        const cookieNone = await fetchText(env, app, cookiePath);

        expect(cookieA.json?.cookieVariant).toBe("a");
        expect(cookieB.json?.cookieVariant).toBe("b");
        expect(cookieNone.json?.cookieVariant).toBe("none");
      }

      const [ok, notFound] = await Promise.all([
        waitForStableCachedResponse(env, app, uniquePath("/cache/status/200")),
        waitForStableCachedResponse(env, app, uniquePath("/cache/status/404")),
        expectNotCached(env, app, uniquePath("/cache/set-cookie")),
        expectNotCached(env, app, uniquePath("/cache/status/500")),
      ]);
      expect(ok.token).toBeDefined();
      expect(notFound.observations.at(-1)?.status).toBe(404);
      expect(notFound.token).toBeDefined();

      if (!(await mutationExists(env, "purgeAppCdnCache"))) {
        console.warn(
          "Skipping CDN purge check: registry does not expose purgeAppCdnCache.",
        );
        return;
      }

      const purgeCase = crypto.randomUUID();
      const pathA = `/cache/max-age?case=${purgeCase}&item=a`;
      const pathB = `/cache/max-age?case=${purgeCase}&item=b`;
      const beforeA = await waitForStableCachedResponse(env, app, pathA);
      const beforeB = await waitForStableCachedResponse(env, app, pathB);

      expect(beforeA.token).not.toBe(beforeB.token);

      await purgeAppCdnCache(env, app);

      const afterA = await waitForPurgeToTakeEffect(
        env,
        app,
        pathA,
        beforeA.token,
      );
      const afterB = await waitForPurgeToTakeEffect(
        env,
        app,
        pathB,
        beforeB.token,
      );

      expect(afterA.token).not.toBe(beforeA.token);
      expect(afterB.token).not.toBe(beforeB.token);

      const stableA = await waitForStableCachedResponse(env, app, pathA);
      expect(stableA.token).toBe(afterA.token);
    } finally {
      await env.deleteApp(app);
    }
  });
});
