// Local integration test for the artillery-http executor (QA-638, AC-2).
// Artillery is driven as the real binary against a real HTTP target, because
// the claims being made — that a resolved fixture URL reaches the server,
// that Artillery's own thresholds decide the outcome, and that its metrics
// arrive as verdict input — are all claims about that boundary. A fake
// Artillery would pass while the real one changed its report format.

import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeArtilleryHttp } from "../../ass/executors/artilleryHttp";
import { evaluateVerdict, NO_STREAM_SOURCES } from "../../ass/engine/verdict";
import type { ResolvedState } from "../../ass/executors/contract";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

let server: Server;
let baseUrl: string;
let requests = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests += 1;
    if (req.url === "/slow") {
      // Enough latency to blow any sane p95 threshold.
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("slow\n");
      }, 250);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ASS-VERDICT: not-reproduced all ok\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function state(variables: Record<string, string>): ResolvedState {
  return {
    env: "local",
    variables,
    components: {},
    pins: {},
    execEnv: {},
    artifactsDir: mkdtempSync(path.join(tmpdir(), "ass-artillery-")),
    composeLogPath: null,
    cleanup: async () => [],
  };
}

describe("artillery-http against a real local target", () => {
  test("resolves {{ victim.url }} and returns Artillery's metrics as counters", async () => {
    const before = requests;
    const outcome = await executeArtilleryHttp(
      {
        target: "{{ victim.url }}",
        phases: [{ duration: 1, arrivalCount: 5 }],
        scenarios: [{ flow: [{ get: { url: "/" } }] }],
      },
      state({ "victim.url": baseUrl }),
      { repoDir: REPO_ROOT, scenarioDir: REPO_ROOT },
    );

    expect(outcome.exitCode).toBe(0);
    expect(requests - before).toBe(5);
    // The interpolated target is what Artillery was actually given.
    expect(readFileSync(outcome.logs["artillery-script"], "utf8")).toContain(
      `target: ${baseUrl}`,
    );
    expect(outcome.counters["http.codes.200"]).toBe(5);
    expect(outcome.counters["http.requests"]).toBe(5);
    // The raw report stays locatable for anything the counters flattened away.
    expect(outcome.logs["artillery-report"]).toContain("artillery-report.json");
  }, 120000);

  test("a failed threshold is a result, not a crash: not-reproduced with evidence", async () => {
    const outcome = await executeArtilleryHttp(
      {
        target: "{{ victim.url }}",
        phases: [{ duration: 1, arrivalCount: 3 }],
        // The target sleeps 250ms; a 10ms p95 cannot hold.
        ensure: { thresholds: [{ "http.response_time.p95": 10 }] },
        scenarios: [{ flow: [{ get: { url: "/slow" } }] }],
      },
      state({ "victim.url": baseUrl }),
      { repoDir: REPO_ROOT, scenarioDir: REPO_ROOT },
    );

    // Artillery signals the breach through its exit status...
    expect(outcome.exitCode).not.toBe(0);
    const stdout = readFileSync(outcome.logs["stdout"], "utf8");
    expect(stdout).toMatch(/p95/);
    // ...and the latency that breached it is verdict input, not just prose.
    expect(outcome.counters["http.response_time.p95"]).toBeGreaterThan(10);

    // A verdict that was looking for a panic did not find one. A threshold
    // breach is a performance fact; deciding it is a reproduction is the
    // scenario's job, so the outcome here stays not-reproduced.
    const evaluation = evaluateVerdict(
      {
        reproduced_when: {
          any: [{ output_matches: { pattern: "panicked at" } }],
        },
      },
      outcome,
      NO_STREAM_SOURCES,
    );
    expect(evaluation.outcome).toBe("not-reproduced");
  }, 120000);
});
