// Drives the connect/close cycle from fixtures/node/src/main.js and nothing
// else: connectPostgres() opens a TLS-first client to the app database, falls
// back to plaintext on an SSL error, and closes it.
//
// This script only generates load. It does not judge anything, because it
// cannot see its own memory: under wasix Node, process.memoryUsage() reports
// rss 0 and a heapTotal (0.47 MB) smaller than its own heapUsed, and
// globalThis.gc is undefined. measure.mjs watches this process from the host
// instead, where the wasm linear memory shows up as ordinary RSS.
//
// Dependency-free on purpose: nothing ships a node_modules to a wasmer volume
// or a deployed app bundle, so the Postgres handshake is spoken directly.
// Time-bounded rather than cycle-bounded so the host and the guest do equal
// wall-clock work whatever their throughput.

import net from "node:net";
import tls from "node:tls";

const DURATION_S = Number(process.env.PROBE_DURATION_S || 180);
// Both runtimes must collect on the same schedule or the comparison is
// worthless: unforced, V8 grows RSS lazily and a healthy host reads as a leak
// (slope 1.18 over 19511 cycles, measured). The guest honours --expose-gc too,
// so refuse to run without it rather than emit a number nobody should trust.
const GC_EVERY = Number(process.env.PROBE_GC_EVERY || 100);
const gc = typeof globalThis.gc === "function" ? globalThis.gc : null;
if (gc === null) {
  process.stderr.write(
    "PROBE-ERROR no forced collection: pass --expose-gc to the runtime\n",
  );
  process.exit(1);
}
const CONNECT_TIMEOUT_MS = 10_000;
const HOST = process.env.DB_HOST || "127.0.0.1";
const PORT = Number(process.env.DB_PORT || 55432);
const USER = process.env.DB_USERNAME || "probe";
const DATABASE = process.env.DB_NAME || "probe";

// RFC 6066 forbids an IP in SNI, and Node warns on every handshake otherwise.
const sni = net.isIP(HOST) !== 0 ? {} : { servername: HOST };

const SSL_REQUEST = (() => {
  const b = Buffer.alloc(8);
  b.writeInt32BE(8, 0);
  b.writeInt32BE(80877103, 4);
  return b;
})();

const STARTUP = (() => {
  const body = Buffer.from(`user\0${USER}\0database\0${DATABASE}\0\0`, "utf8");
  const b = Buffer.alloc(8 + body.length);
  b.writeInt32BE(b.length, 0);
  b.writeInt32BE(196608, 4); // protocol 3.0
  body.copy(b, 8);
  return b;
})();

function cycle() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => done(new Error(`connect timed out after ${CONNECT_TIMEOUT_MS} ms`)),
      CONNECT_TIMEOUT_MS,
    );
    const socket = net.connect({ host: HOST, port: PORT });
    socket.on("error", done);
    socket.once("connect", () => socket.write(SSL_REQUEST));
    socket.once("data", (reply) => {
      if (reply[0] === 0x53 /* 'S' */) {
        // TLS arm: what a managed endpoint answers, and the path prod takes.
        const secure = tls.connect(
          { socket, rejectUnauthorized: false, ...sni },
          () => secure.write(STARTUP),
        );
        secure.on("error", done);
        // The auth challenge is enough; completing SCRAM would add nothing to
        // what is being measured.
        secure.once("data", () => {
          secure.destroy();
          done();
        });
        return;
      }
      // Plaintext arm: the fixture's fallback when the server has no SSL.
      socket.write(STARTUP);
      socket.once("data", () => {
        socket.destroy();
        done();
      });
    });
  });
}

const deadline = Date.now() + DURATION_S * 1000;
let cycles = 0;
let reported = 0;
while (Date.now() < deadline) {
  try {
    await cycle();
  } catch (err) {
    process.stderr.write(`PROBE-ERROR cycle ${cycles + 1}: ${err}\n`);
    process.exit(1);
  }
  cycles++;
  if (cycles % GC_EVERY === 0) {
    gc();
    gc();
  }
  // Liveness for the host-side measurer: a stalled peer must not look like a
  // flat memory curve.
  if (cycles - reported >= 250) {
    reported = cycles;
    process.stderr.write(`PROBE-CYCLES ${cycles}\n`);
  }
}
process.stderr.write(`PROBE-DONE ${cycles}\n`);
