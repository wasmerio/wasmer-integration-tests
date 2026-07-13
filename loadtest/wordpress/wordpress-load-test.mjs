#!/usr/bin/env node

/**
 * Runs a standalone Artillery load test against a WordPress site.
 *
 * The first phase crawls same-origin HTML pages, beginning at `--url` and
 * `/wp-admin/`. URLs are normalized, deduplicated, and limited by `--max-urls`
 * so recursive navigation and parameterized pages cannot cause an unbounded
 * crawl. When `--include-assets` is set, the crawler also records same-origin
 * JavaScript, stylesheet, and image URLs from every crawled HTML page.
 *
 * The second phase writes a temporary Artillery configuration with one static
 * request per discovered URL. Each virtual user runs that complete request list
 * `--count` times, while `--concurrency` controls the number of virtual users.
 * Artillery's metrics-by-endpoint plugin reports each URL independently and
 * Artillery's standard summary reports aggregate totals. Requests use
 * `Cache-Control: no-cache, no-store, max-age=0` to avoid CDN caching.
 *
 * Run `./loadtest/wordpress/wordpress-load-test.mjs --help` for CLI details.
 */

import console from "node:console";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";

import { execa } from "execa";
import { dump } from "js-yaml";

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_COUNT = 1;
const DEFAULT_MAX_URLS = 1_000;
const CACHE_CONTROL_HEADER = "no-cache, no-store, max-age=0";

function requiredUrl(value) {
  if (!value) {
    throw new Error("--url is required");
  }

  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`--url must use HTTP or HTTPS, received: ${url.protocol}`);
  }

  url.hash = "";
  return url;
}

function positiveInteger(name, value, defaultValue) {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, received: ${value}`);
  }

  return parsed;
}

function parseArguments(args) {
  let url;
  let concurrency;
  let count;
  let maxUrls;
  let includeAssets = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }
    if (argument === "--include-assets") {
      includeAssets = true;
      continue;
    }
    if (argument === "--exclude-assets") {
      includeAssets = false;
      continue;
    }

    const [flag, inlineValue] = argument.split("=", 2);
    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }

    switch (flag) {
      case "--url":
        url = value;
        break;
      case "--concurrency":
        concurrency = value;
        break;
      case "--count":
        count = value;
        break;
      case "--max-urls":
        maxUrls = value;
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  return { url, concurrency, count, maxUrls, includeAssets };
}

function printUsage() {
  console.info(`Usage: wordpress-load-test.mjs --url <url> [options]

Options:
  --url <url>              WordPress site URL to crawl and load (required)
  --concurrency <number>   Concurrent Artillery virtual users (default: 10)
  --count <number>         Times each virtual user loads every URL (default: 1)
  --include-assets         Load discovered scripts, stylesheets, and images
  --exclude-assets         Do not load assets (the default)
  --max-urls <number>      Maximum same-origin URLs to crawl (default: 1000)
  -h, --help               Show this help message`);
}

function normalizeUrl(value, base, origin) {
  try {
    const url = new URL(value, base);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== origin
    ) {
      return null;
    }

    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function attributeValue(attributes, name) {
  const pattern = new RegExp(
    "\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
    "i",
  );
  const match = attributes.match(pattern);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function extractUrls(html, pageUrl, origin) {
  const pageLinks = new Set();
  const assets = new Set();
  const tagPattern = /<(a|area|img|link|script)\b([^>]*)>/gi;

  for (const match of Array.from(html.matchAll(tagPattern))) {
    const [, tagName, attributes] = match;
    const urlValue = attributeValue(
      attributes,
      tagName === "script" || tagName === "img" ? "src" : "href",
    );
    if (!urlValue) {
      continue;
    }

    const url = normalizeUrl(urlValue, pageUrl, origin);
    if (!url) {
      continue;
    }

    if (tagName === "a" || tagName === "area") {
      pageLinks.add(url.href);
    } else if (
      tagName === "script" ||
      tagName === "img" ||
      attributeValue(attributes, "rel")?.split(/\s+/).includes("stylesheet")
    ) {
      assets.add(url.href);
    }
  }

  return {
    pageLinks: Array.from(pageLinks, (link) => new URL(link)),
    assets: Array.from(assets, (asset) => new URL(asset)),
  };
}

async function crawlSite(startUrl, maxUrls, includeAssets) {
  const origin = startUrl.origin;
  const wpAdminUrl = new URL("/wp-admin/", origin);
  const queued = [startUrl, wpAdminUrl];
  const discovered = new Set([startUrl.href, wpAdminUrl.href]);
  const seen = new Set();
  const loadUrls = new Set([wpAdminUrl.href]);

  while (
    queued.length > 0 &&
    (seen.size < maxUrls || queued[0]?.href === wpAdminUrl.href)
  ) {
    const url = queued.shift();
    if (!url || seen.has(url.href)) {
      continue;
    }
    seen.add(url.href);
    loadUrls.add(url.href);

    console.info(`Crawling ${url.href}`);
    try {
      const response = await globalThis.fetch(url, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "cache-control": CACHE_CONTROL_HEADER,
        },
      });
      const responseUrl = new URL(response.url);
      if (responseUrl.origin !== origin) {
        console.warn(`Skipping redirect outside ${origin}: ${response.url}`);
        continue;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) {
        continue;
      }

      const { pageLinks, assets } = extractUrls(
        await response.text(),
        responseUrl,
        origin,
      );
      if (includeAssets) {
        for (const asset of assets) {
          if (!loadUrls.has(asset.href)) {
            console.info(`Discovered asset ${asset.href}`);
            loadUrls.add(asset.href);
          }
        }
      }

      for (const link of pageLinks) {
        if (discovered.size < maxUrls && !discovered.has(link.href)) {
          discovered.add(link.href);
          queued.push(link);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not crawl ${url.href}: ${message}`);
    }
  }

  if (discovered.size === maxUrls && queued.length > 0) {
    console.warn(`Stopped crawling after reaching --max-urls=${maxUrls}`);
  }

  return Array.from(loadUrls, (url) => new URL(url));
}

function toRequestPath(url) {
  return `${url.pathname}${url.search}`;
}

async function runArtillery(urls, concurrency, count, target) {
  const workDir = await mkdtemp(join(tmpdir(), "wordpress-load-test-"));
  const configPath = join(workDir, "artillery.yml");
  const requests = urls.map((url) => ({
    get: { url: toRequestPath(url) },
  }));

  await writeFile(
    configPath,
    dump({
      config: {
        target: target.origin,
        http: {
          defaults: {
            headers: {
              "cache-control": CACHE_CONTROL_HEADER,
            },
          },
        },
        phases: [
          {
            name: `Load every discovered URL with ${concurrency} virtual users`,
            duration: 1,
            arrivalCount: concurrency,
            maxVusers: concurrency,
          },
        ],
        plugins: {
          "metrics-by-endpoint": {},
        },
      },
      scenarios: [
        {
          name: "Crawl-discovered WordPress pages",
          flow: [
            {
              loop: requests,
              count,
            },
          ],
        },
      ],
    }),
  );

  console.info(`Discovered ${urls.length} URLs; Artillery input: ${workDir}`);
  await execa("pnpm", ["exec", "artillery", "run", configPath], {
    stdio: "inherit",
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const startUrl = requiredUrl(options.url);
  const concurrency = positiveInteger(
    "--concurrency",
    options.concurrency,
    DEFAULT_CONCURRENCY,
  );
  const count = positiveInteger("--count", options.count, DEFAULT_COUNT);
  const maxUrls = positiveInteger(
    "--max-urls",
    options.maxUrls,
    DEFAULT_MAX_URLS,
  );
  const urls = await crawlSite(startUrl, maxUrls, options.includeAssets);

  if (urls.length === 0) {
    throw new Error(`No URLs were discovered from ${startUrl.href}`);
  }

  await runArtillery(urls, concurrency, count, startUrl);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
