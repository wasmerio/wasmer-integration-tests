// Node implementation of the fixture contract (fixtures/openapi.yaml for
// HTTP, fixtures/asyncapi.yaml for the /ws WebSocket channel).
// Zero-framework: node:http only. The pg/mysql2 drivers are loaded lazily
// inside the /results handler so every other endpoint works without
// node_modules.

import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";

import { WebSocketServer } from "ws";

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
const COUNTER_NAME_RE = /^[a-z-]+$/;

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
  if (segments.length > 2 || !COUNTER_NAME_RE.test(name)) {
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

// --- websocket (fixtures/asyncapi.yaml) -----------------------------------

const REQUEST_ID_RE = /^[A-Za-z0-9-]{1,16}$/;
const BINARY_HEADER_BYTES = 16;
const UNKNOWN_REQUEST_ID = "unknown";
const MAX_BINARY_PAYLOAD = 65536;

function wsSend(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function wsError(socket, requestId, code, message) {
  wsSend(socket, {
    type: "error.response",
    requestId: REQUEST_ID_RE.test(requestId ?? "")
      ? requestId
      : UNKNOWN_REQUEST_ID,
    code,
    message,
  });
}

// The contract's echo value domain: strings, booleans, null, safe integers,
// and arrays/objects of those. Floats are rejected because their text form
// is not stable across runtimes.
function isEchoValue(value) {
  if (value === null) {
    return true;
  }
  const type = typeof value;
  if (type === "string" || type === "boolean") {
    return true;
  }
  if (type === "number") {
    return Number.isInteger(value) && Number.isSafeInteger(value);
  }
  if (Array.isArray(value)) {
    return value.every(isEchoValue);
  }
  if (type === "object") {
    return Object.values(value).every(isEchoValue);
  }
  return false;
}

function hasExactKeys(payload, keys) {
  const actual = Object.keys(payload);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
}

// Returns an error string, or null when the payload conforms.
function validateRequest(payload) {
  if (!REQUEST_ID_RE.test(payload.requestId ?? "")) {
    return "requestId must match ^[A-Za-z0-9-]{1,16}$";
  }
  switch (payload.type) {
    case "echo.request":
      if (!hasExactKeys(payload, ["type", "requestId", "value"])) {
        return "echo.request accepts exactly type, requestId and value";
      }
      return isEchoValue(payload.value)
        ? null
        : "value is outside the contract's echo value domain";
    case "notification.request":
      if (
        !hasExactKeys(payload, ["type", "requestId", "message", "delay_ms"])
      ) {
        return "notification.request accepts exactly type, requestId, message and delay_ms";
      }
      if (typeof payload.message !== "string") {
        return "message must be a string";
      }
      return Number.isInteger(payload.delay_ms) &&
        payload.delay_ms >= 0 &&
        payload.delay_ms <= 10000
        ? null
        : "delay_ms must be an integer between 0 and 10000";
    case "error.request":
      if (!hasExactKeys(payload, ["type", "requestId", "code"])) {
        return "error.request accepts exactly type, requestId and code";
      }
      return payload.code === "requested_failure"
        ? null
        : "code must be requested_failure";
    default:
      return null;
  }
}

function handleTextFrame(socket, raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return wsError(
      socket,
      UNKNOWN_REQUEST_ID,
      "invalid_payload",
      "Frame is not valid JSON",
    );
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return wsError(
      socket,
      UNKNOWN_REQUEST_ID,
      "invalid_payload",
      "Frame is not a JSON object",
    );
  }

  const known = [
    "echo.request",
    "notification.request",
    "error.request",
  ].includes(payload.type);
  if (!known) {
    return wsError(
      socket,
      payload.requestId,
      "unknown_message_type",
      `Unsupported message type: ${payload.type}`,
    );
  }

  const problem = validateRequest(payload);
  if (problem) {
    return wsError(socket, payload.requestId, "invalid_payload", problem);
  }

  switch (payload.type) {
    case "echo.request":
      return wsSend(socket, {
        type: "echo.response",
        requestId: payload.requestId,
        value: payload.value,
      });
    case "notification.request":
      setTimeout(() => {
        wsSend(socket, {
          type: "notification.event",
          requestId: payload.requestId,
          message: payload.message,
        });
      }, payload.delay_ms);
      return undefined;
    case "error.request":
      return wsError(
        socket,
        payload.requestId,
        "requested_failure",
        "The client requested this error.",
      );
  }
}

function handleBinaryFrame(socket, frame) {
  if (frame.length < BINARY_HEADER_BYTES) {
    return wsError(
      socket,
      UNKNOWN_REQUEST_ID,
      "invalid_payload",
      `Binary frame is shorter than the ${BINARY_HEADER_BYTES}-byte header`,
    );
  }
  if (frame.length - BINARY_HEADER_BYTES > MAX_BINARY_PAYLOAD) {
    const requestId = frame
      .subarray(0, BINARY_HEADER_BYTES)
      .toString("ascii")
      .trimEnd();
    return wsError(
      socket,
      requestId,
      "invalid_payload",
      `Binary payload exceeds ${MAX_BINARY_PAYLOAD} bytes`,
    );
  }
  // Header and payload both go back byte-identical.
  if (socket.readyState === socket.OPEN) {
    socket.send(frame, { binary: true });
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

wss.on("connection", (socket) => {
  // ws answers pings with a matching pong and completes the closing
  // handshake on its own; both are contract obligations, so they are noted
  // rather than reimplemented.
  socket.on("message", (data, isBinary) => {
    try {
      if (isBinary) {
        handleBinaryFrame(socket, Buffer.from(data));
      } else {
        handleTextFrame(socket, Buffer.from(data).toString("utf-8"));
      }
    } catch (err) {
      wsError(
        socket,
        UNKNOWN_REQUEST_ID,
        "invalid_payload",
        `Frame could not be processed: ${err}`,
      );
    }
  });
  socket.on("error", () => {});
});

// --- catch-all ------------------------------------------------------------

function echoPayload(pathname) {
  return {
    echo: pathname.replace(/^\/+|\/+$/g, ""),
    unique_hash: UNIQUE_HASH,
  };
}

function handleEcho(req, res, pathname) {
  const line = `${timestamp()} - ${req.url}`;
  process.stdout.write(line + "\n");
  process.stderr.write(line + "\n");
  return json(res, echoPayload(pathname));
}

// --- self-test ------------------------------------------------------------

// Aggregate probe endpoint (openapi.yaml selfTest): every inside-runnable
// contract check in one report, 200 only when all pass. No check opens a
// connection back to the instance — guest loopback is not routable on Edge.
async function runCheck(name, fn) {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  try {
    await fn();
    return { name, ok: true, elapsed_ms: elapsed() };
  } catch (err) {
    return {
      name,
      ok: false,
      elapsed_ms: elapsed(),
      error: String(err instanceof Error ? err.message : err),
    };
  }
}

function checkExpect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function checkCounter(name) {
  const before = await counterValue(name, false);
  const after = await counterValue(name, true);
  checkExpect(
    Number.isInteger(before) && Number.isInteger(after),
    `counter ${name} did not read as an integer`,
  );
  // Strictly greater rather than +1: concurrent probes may interleave.
  checkExpect(
    after > before,
    `counter ${name} did not advance (${before} -> ${after})`,
  );
}

async function handleSelfTest(res) {
  const checks = [];

  checks.push(
    await runCheck("db-env", () => {
      const report = dbEnvReport();
      checkExpect(
        report.present.length + report.missing.length ===
          REQUIRED_DB_VARS.length,
        "db-env report does not partition the required vars",
      );
      checkExpect(
        report.present.length === 0 || report.missing.length === 0,
        `partial DB_* injection: missing ${report.missing.join(", ")}`,
      );
    }),
  );
  checks.push(
    await runCheck("db-connect", async () => {
      const result = await checkDbConnection();
      if (dbEnvReport().missing.length === 0) {
        checkExpect(result === "OK", result);
      } else {
        checkExpect(
          result.startsWith("Missing required SQL environment variables"),
          result,
        );
      }
    }),
  );
  checks.push(
    await runCheck("counter-default", () => checkCounter("counter")),
  );
  checks.push(
    await runCheck("counter-named", () => checkCounter("self-test")),
  );
  checks.push(
    await runCheck("counter-invalid-name", () => {
      checkExpect(
        !COUNTER_NAME_RE.test("NOT-VALID") && COUNTER_NAME_RE.test("self-test"),
        "counter name validation does not enforce ^[a-z-]+$",
      );
    }),
  );
  checks.push(
    await runCheck("echo", () => {
      const payload = echoPayload("/self-test/echo/");
      checkExpect(
        payload.echo === "self-test/echo",
        `echo did not strip surrounding slashes: ${payload.echo}`,
      );
      checkExpect(
        typeof payload.unique_hash === "string" &&
          payload.unique_hash.length > 0,
        "unique_hash is empty",
      );
    }),
  );

  const ok = checks.every((check) => check.ok);
  return json(res, { ok, checks, unique_hash: UNIQUE_HASH }, ok ? 200 : 500);
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
    // Excluded from the catch-all and never logged, like /ws.
    if (pathname === "/self-test" && req.method === "GET") {
      return await handleSelfTest(res);
    }
    // Reserved by fixtures/asyncapi.yaml: refused without an upgrade, and
    // never logged, so it stays out of the catch-all entirely.
    if (pathname === "/ws") {
      return text(res, "Upgrade Required", 426);
    }
    if (req.method === "GET") {
      return handleEcho(req, res, pathname);
    }
    return text(res, "Not Found", 404);
  } catch (err) {
    return text(res, `Internal error: ${err}`, 500);
  }
});

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Starting server on http://${HOST}:${PORT}`);
});
