// Node implementation of the fixture contract (fixtures/openapi.yaml).
// Zero-framework: node:http only. The pg/mysql2 drivers are loaded lazily
// inside the /results handler so every other endpoint works without
// node_modules.

import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || "/data";

// Replaced per deployment by the test harness, like the other fixtures.
const UNIQUE_HASH = "__TEMPLATE__";

const REQUIRED_DB_VARS = [
  "DB_HOST",
  "DB_PORT",
  "DB_USERNAME",
  "DB_PASSWORD",
  "DB_NAME",
];

function json(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function text(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// --- database-environment -------------------------------------------------

function dbEnvReport() {
  const present = REQUIRED_DB_VARS.filter((name) => process.env[name] != null);
  const missing = REQUIRED_DB_VARS.filter((name) => process.env[name] == null);
  return {
    present,
    missing,
    host: process.env.DB_HOST ?? null,
    port: process.env.DB_PORT ?? null,
    name: process.env.DB_NAME ?? null,
    username: process.env.DB_USERNAME ?? null,
    hasPassword: process.env.DB_PASSWORD != null,
    hasDatabaseUrl: process.env.DATABASE_URL != null,
    hasDbEngine: process.env.DB_ENGINE != null,
  };
}

// --- database-connectivity ------------------------------------------------

function dbEngine() {
  const engine = (process.env.DB_ENGINE || "").toLowerCase();
  if (engine.includes("postgres") || engine.includes("pg")) {
    return "postgres";
  }
  if (engine.includes("mysql") || engine.includes("maria")) {
    return "mysql";
  }
  const url = process.env.DATABASE_URL || "";
  if (url.startsWith("postgres")) {
    return "postgres";
  }
  if (url.startsWith("mysql")) {
    return "mysql";
  }
  // Managed apps get neither DB_ENGINE nor DATABASE_URL, only DB_*.
  // Hostname contract: PostgreSQL endpoints live under psql.<region>,
  // MySQL under db.<region>/mysql.<region>.
  const host = process.env.DB_HOST || "";
  if (host.startsWith("psql.")) {
    return "postgres";
  }
  if (host.startsWith("db.") || host.startsWith("mysql.")) {
    return "mysql";
  }
  if (process.env.DB_PORT === "5432") {
    return "postgres";
  }
  if (process.env.DB_PORT === "3306") {
    return "mysql";
  }
  // No engine signal (e.g. local platform: raw IP host, remapped port).
  return null;
}

async function connectPostgres(config) {
  const { default: pg } = await import("pg");
  const base = { ...config, connectionTimeoutMillis: 10_000 };
  // TLS first (managed endpoints enforce sslmode=require), plaintext
  // fallback for TLS-less endpoints like the local platform.
  const withTls = new pg.Client({
    ...base,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await withTls.connect();
    await withTls.end();
  } catch (err) {
    await withTls.end().catch(() => {});
    if (!/ssl/i.test(err instanceof Error ? err.message : String(err))) {
      throw err;
    }
    const plaintext = new pg.Client(base);
    await plaintext.connect();
    await plaintext.end();
  }
}

async function connectMysql(config) {
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection({
    ...config,
    connectTimeout: 10_000,
  });
  await conn.end();
}

async function checkDbConnection() {
  const missing = REQUIRED_DB_VARS.filter((name) => process.env[name] == null);
  if (missing.length > 0) {
    return `Missing required SQL environment variables: ${missing.join(", ")}`;
  }

  const config = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };

  // When the engine is ambiguous, probe postgres first: pg fails fast
  // against a MySQL server, while mysql2 waits out its whole connect
  // timeout against PostgreSQL (both protocols expect the peer to speak
  // first).
  const engine = dbEngine();
  const candidates = engine ? [engine] : ["postgres", "mysql"];
  const errors = [];
  for (const candidate of candidates) {
    try {
      if (candidate === "postgres") {
        await connectPostgres(config);
      } else {
        await connectMysql(config);
      }
      return "OK";
    } catch (err) {
      errors.push(
        `${candidate}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return `Connection failed: ${errors.join("; ")}`;
}

// --- durable-state --------------------------------------------------------

// The server is a single process, so a per-counter promise chain makes
// read-modify-write cycles atomic under concurrent requests.
const counterLocks = new Map();

function withCounterLock(name, fn) {
  const previous = counterLocks.get(name) || Promise.resolve();
  const next = previous.then(fn, fn);
  counterLocks.set(name, next);
  return next;
}

function counterValue(name, increment) {
  return withCounterLock(name, async () => {
    const file = path.join(DATA_DIR, name);
    let value = 0;
    try {
      value = parseInt(await fs.readFile(file, "utf-8"), 10) || 0;
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
    if (increment) {
      value++;
      await fs.writeFile(file, String(value));
    }
    return value;
  });
}

async function handleCounter(req, res, segments) {
  const name = segments[1] ?? "counter";
  if (segments.length > 2 || !/^[a-z-]+$/.test(name)) {
    return text(res, "Not Found", 404);
  }
  let increment;
  if (req.method === "GET") {
    increment = false;
  } else if (req.method === "POST") {
    increment = true;
  } else {
    return text(res, "Not Found", 404);
  }
  try {
    const value = await counterValue(name, increment);
    return text(res, String(value));
  } catch {
    return text(res, "Failed to access durable counter storage", 500);
  }
}

// --- outbound-http --------------------------------------------------------

// Node has no true blocking HTTP I/O. The two endpoints instead exercise
// the two distinct native network stacks: /sync uses the callback-based
// node:http(s) client and /async uses the promise-based global fetch.
function callbackRequest(method, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(url, { method }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          body: Buffer.concat(chunks).toString("utf-8"),
          status_code: res.statusCode,
        }),
      );
      res.on("error", reject);
    });
    // A plain timer, not req.setTimeout: the socket inactivity timer does
    // not cover the connect phase, so unroutable targets would hang past
    // the deadline.
    const timer = setTimeout(() => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
}

async function fetchRequest(method, target, timeoutMs) {
  const response = await fetch(target, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { body: await response.text(), status_code: response.status };
}

async function handleProxy(req, res, mode) {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  try {
    const payload = JSON.parse(await readBody(req));
    const doRequest = mode === "async" ? fetchRequest : callbackRequest;
    const result = await doRequest(
      payload.method,
      payload.target,
      payload.timeout_ms,
    );
    return json(res, { ...result, elapsed_time_ms: elapsed() });
  } catch (err) {
    return json(res, {
      error: String(err instanceof Error ? err.message : err),
      status_code: 500,
      elapsed_time_ms: elapsed(),
    });
  }
}

// --- catch-all ------------------------------------------------------------

function handleEcho(req, res, pathname) {
  const line = `${timestamp()} - ${req.url}`;
  process.stdout.write(line + "\n");
  process.stderr.write(line + "\n");
  return json(res, {
    echo: pathname.replace(/^\/+|\/+$/g, ""),
    unique_hash: UNIQUE_HASH,
  });
}

// --- router ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const segments = pathname.split("/").filter(Boolean);

  try {
    if (pathname === "/" && req.method === "GET") {
      return json(res, { message: "Hello World" });
    }
    if (pathname === "/db-env" && req.method === "GET") {
      return json(res, dbEnvReport());
    }
    if (pathname === "/results" && req.method === "GET") {
      return text(res, await checkDbConnection());
    }
    if (segments[0] === "inc") {
      return await handleCounter(req, res, segments);
    }
    if (pathname === "/async" && req.method === "POST") {
      return await handleProxy(req, res, "async");
    }
    if (pathname === "/sync" && req.method === "POST") {
      return await handleProxy(req, res, "sync");
    }
    if (req.method === "GET") {
      return handleEcho(req, res, pathname);
    }
    return text(res, "Not Found", 404);
  } catch (err) {
    return text(res, `Internal error: ${err}`, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Starting server on http://${HOST}:${PORT}`);
});
