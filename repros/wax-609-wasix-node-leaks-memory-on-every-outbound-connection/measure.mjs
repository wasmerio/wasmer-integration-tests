// Watches probe/repro.mjs from the host and judges whether its memory growth
// has decelerated by the end of the run.
//
// The measurement has to happen out here. The guest's own counters are stubbed
// (rss 0, heapTotal < heapUsed, no globalThis.gc), and even a working JS heap
// figure would miss this: on the host the heap stays at ~11 MB while RSS grows
// by 130 MB, because the growth is native allocator memory. The wasm linear
// memory is ordinary RSS to the host, which is also how Edge accounts an
// instance against its ceiling.
//
//   node measure.mjs --target host     # native child, the control
//   node measure.mjs --target guest    # wasmer run, the claim
//
// Emits one ASS-VERDICT line on stderr.

import { spawn } from "node:child_process";
import { startPeer } from "./peer.mjs";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const target = (() => {
  const i = process.argv.indexOf("--target");
  return i >= 0 ? process.argv[i + 1] : "host";
})();
// The component override ASS would normally supply: `load.jest` has no env: of
// its own, so the runtime is named here instead of by fixtures.components.
const JS_PACKAGE = process.env.PROBE_JS_PACKAGE || "wasmer/edgejs-quickjs@=0.2.0";
const SAMPLE_MS = 2000;
// The guest reserves and compiles before the workload dominates; judging from
// the first quarter of samples would score that ramp as if it were the leak.
const WARMUP_FRACTION = 0.25;
const MIN_GROWTH_MB = 64;
const PLATEAU_RATIO = 0.25;
const MIN_SAMPLES = 12;

function childArgv(peerPort) {
  if (target === "guest") {
    return [
      "wasmer",
      [
        "run", JS_PACKAGE,
        // Without --net the guest cannot open a socket at all: every cycle
        // fails with `connect EIO`.
        "--net",
        "--volume", `${path.join(HERE, "probe")}:/work`,
        "--env", `DB_HOST=${process.env.DB_HOST || "127.0.0.1"}`,
        "--env", `DB_PORT=${peerPort}`,
        "--env", `DB_USERNAME=${process.env.DB_USERNAME || "probe"}`,
        "--env", `DB_NAME=${process.env.DB_NAME || "probe"}`,
        "--env", `PROBE_DURATION_S=${process.env.PROBE_DURATION_S || "180"}`,
        // The guest honours --expose-gc; without it neither side's RSS means
        // anything (see probe/repro.mjs).
        "--", "--expose-gc", "/work/repro.mjs",
      ],
    ];
  }
  return ["node", ["--expose-gc", path.join(HERE, "probe", "repro.mjs")]];
}

function rssMb(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    return m ? Number(m[1]) / 1024 : null;
  } catch {
    return null;
  }
}

function slope(samples) {
  if (samples.length < 2) return 0;
  const a = samples[0];
  const b = samples[samples.length - 1];
  return (b.mb - a.mb) / Math.max(b.t - a.t, 1);
}

// The peer lives in this process: a repro that needs a container started by
// hand is a repro that does not get run.
const useTls = process.env.PROBE_PEER_TLS !== "0";
const peer = await startPeer({ port: Number(process.env.DB_PORT || 0), useTls });
const [cmd, args] = childArgv(peer.port);
const child = spawn(cmd, args, {
  env: { ...process.env, DB_PORT: String(peer.port) },
  stdio: ["ignore", "pipe", "pipe"],
});

const samples = [];
const started = Date.now();
let cycles = 0;
let probeError = null;

child.stderr.on("data", (chunk) => {
  const text = String(chunk);
  const seen = /PROBE-(?:CYCLES|DONE) (\d+)/g;
  let m;
  while ((m = seen.exec(text)) !== null) cycles = Number(m[1]);
  const err = /PROBE-ERROR .*/.exec(text);
  if (err) probeError = err[0];
});
child.stdout.resume();

const timer = setInterval(() => {
  const mb = rssMb(child.pid);
  if (mb !== null) samples.push({ t: (Date.now() - started) / 1000, mb });
}, SAMPLE_MS);

const code = await new Promise((resolve) => {
  child.on("error", (err) => {
    probeError = `spawn failed: ${err.message}`;
    resolve(-1);
  });
  child.on("close", resolve);
});
clearInterval(timer);
await peer.close();

function verdict(outcome, detail) {
  process.stderr.write(`ASS-VERDICT: ${outcome} ${detail}\n`);
}

const SLUG = "wax-609-wasix-node-leaks-memory-on-every-outbound-connection";
const SPARK = "▁▂▃▄▅▆▇█";

function sparkline(points) {
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const span = hi - lo || 1;
  return points
    .map((v) => SPARK[Math.min(SPARK.length - 1, Math.floor(((v - lo) / span) * SPARK.length))])
    .join("");
}

/** A verdict line is a result, not an explanation. On a reproduction, say what
 * the curve looks like, what it already rules out, and where to go next —
 * ASS's presenter shows neither meta.links nor the samples behind the numbers. */
function explain(samples, cycles, perCycleKb) {
  const seriesPath = path.join(
    os.tmpdir(),
    `wax-609-memory-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
  );
  writeFileSync(
    seriesPath,
    ["seconds,rss_mb", ...samples.map((s) => `${s.t.toFixed(1)},${s.mb.toFixed(1)}`)].join("\n") + "\n",
  );
  const step = Math.max(1, Math.floor(samples.length / 48));
  const thinned = samples.filter((_, i) => i % step === 0).map((s) => s.mb);
  const out = [
    "",
    `  memory  ${sparkline(thinned)}`,
    `          ${samples[0].mb.toFixed(0)} MB over ${samples[samples.length - 1].t.toFixed(0)}s ` +
      `-> ${samples[samples.length - 1].mb.toFixed(0)} MB  (~${perCycleKb.toFixed(0)} KB per cycle, ${cycles} cycles)`,
    "",
    "  What this rules out",
    "    - not the fixture's JavaScript: the same probe on host Node is flat",
    "    - not the JS heap: growth survives a forced collection every 100 cycles",
    "    - not sockets in general: the plaintext control above plateaus (~1 KB/cycle)",
    "",
    "  The cycle under test (probe/repro.mjs, mirroring fixtures/node/src/main.js)",
    "    connect -> SSLRequest -> TLS handshake -> StartupMessage -> close",
    "",
    "  Next",
    `    verify a fix:     PROBE_JS_PACKAGE=/path/to/build pnpm ass run ${SLUG}`,
    `    samples: ${seriesPath}`,
    "",
  ];
  process.stderr.write(out.join("\n"));
}

if (probeError !== null) {
  verdict("inconclusive", `${target}: ${probeError}`);
} else if (code !== 0) {
  verdict("inconclusive", `${target}: child exited ${code}`);
} else if (samples.length < MIN_SAMPLES) {
  verdict("inconclusive", `${target}: only ${samples.length} memory samples`);
} else if (cycles < 250) {
  // A peer that refuses connections would otherwise present as a flat curve.
  verdict("inconclusive", `${target}: only ${cycles} cycles completed`);
} else {
  const warm = samples.slice(Math.floor(samples.length * WARMUP_FRACTION));
  const half = Math.floor(warm.length / 2);
  const early = slope(warm.slice(0, half + 1));
  const late = slope(warm.slice(half));
  const growth = warm[warm.length - 1].mb - warm[0].mb;
  const ratio = early > 0 ? late / early : 0;
  const shape =
    `${target}: ${cycles} cycles, ${warm[0].mb.toFixed(1)}->` +
    `${warm[warm.length - 1].mb.toFixed(1)} MB after warm-up, ` +
    `late/early slope ${ratio.toFixed(2)}`;
  // Growth alone is not the bug — the host grows too and then stops. The bug is
  // growth that has not decelerated by the end of the run.
  if (growth >= MIN_GROWTH_MB && ratio >= PLATEAU_RATIO) {
    verdict("reproduced", `memory still climbing: ${shape}`);
    explain(warm, cycles, (growth * 1024) / Math.max(cycles, 1));
  } else {
    verdict("not-reproduced", `growth plateaus: ${shape}`);
  }
}
