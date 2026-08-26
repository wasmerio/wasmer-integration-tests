// Phase 5: remote targeting through the TestEnv seam. Everything runs
// against the fake remote platform in helpers.ts — deployment, D14-windowed
// log capture, the engine's HTTP probe read, teardown-with-leak-naming, the
// production gates — plus unit boundaries for the fixed prod caps and the
// D14 quiescence loop.

import { readFileSync } from "node:fs";
import {
  addScenario,
  cli,
  makeFakeHarness,
  makeRoot,
  snapshotTree,
  PERSISTED_TOML,
} from "./helpers";
import {
  captureRemote,
  remoteStreamSources,
} from "../../ass/engine/remoteCapture";
import {
  defaultProdConfirm,
  enforceProdWorkload,
  PROD_CAPS,
} from "../../ass/engine/prod";
import { parseScenario } from "../../ass/scenario/schema";
import { PreflightError } from "../../ass/errors";
import type { ResolvedState } from "../../ass/executors/contract";
import type { RemotePlatform } from "../../ass/fixtures/remote";

const REPRODUCED_MARKER = "ASS-VERDICT: reproduced 5 primitive(s) broken";
const HEALTHY_MARKER = "ASS-VERDICT: not-reproduced all primitives ok";

/** A wax-603-shaped scenario: deployed probe, artillery over it, the D11
 * verdict on both channels, D13 single-instance pin. */
const REMOTE_PROBE_TOML = `
[meta]
id = "RM-1"
title = "remote probe scenario"
lifecycle = { state = "open" }

[fixtures.probes.matrix]
source = "package:./probe"
config = { max_instances = 1 }

[fixtures.components]
python = "registry:python/python@=3.13.5"

[load]
executor = "artillery-http"

[load.artillery-http]
target = "{{ matrix.url }}"
phases = [{ duration = 1, arrivalCount = 1 }]
scenarios = [{ flow = [{ get = { url = "/" } }] }]

[verdict.probe]
channels = [
  { type = "log", stream = "stderr" },
  { type = "http", match = "body" },
]

[verdict.baseline]
waived = "native leg exercised by the raw-wasmer profile locally"
`;

function probeRoot(toml: string = REMOTE_PROBE_TOML): string {
  const root = makeRoot();
  addScenario(root, "repros", "remmy", toml);
  return root;
}

describe("remote runs through the TestEnv seam (Phase 5)", () => {
  test("a dev run deploys the probe, reads both channels, and tears down", async () => {
    const root = probeRoot();
    const harness = makeFakeHarness({
      remoteLogs: `${REPRODUCED_MARKER}\n`,
      remoteBody: `matrix output\n${REPRODUCED_MARKER}\n`,
      // R5-01: the workload's own stderr says the opposite; only the
      // deployed probe's channels may be read under artillery-http.
      workload: { code: 0, stdout: "", stderr: `${HEALTHY_MARKER}\n` },
    });
    const result = await cli(
      root,
      ["run", "remmy", "--env", "dev"],
      harness.deps,
    );
    expect(result.stdout).toContain("reproduced");
    expect(result.code).toBe(0);
    // Package components pin remotely, so the run stays pinned mode.
    expect(result.stdout).toContain("mode: pinned");
    // Deploy before the workload, teardown after the reads; D13 pins a
    // single instance; the local stack is never touched.
    const c = harness.calls;
    expect(c).toContain("remote-platform:dev");
    expect(c).toContain("remote-deploy:probe:single");
    expect(c.indexOf("remote-deploy:probe:single")).toBeLessThan(
      c.findIndex((x) => x.startsWith("exec:")),
    );
    expect(c.indexOf("remote-delete:fake-ns/probe")).toBeGreaterThan(
      c.indexOf("remote-fetch:https://probe.fake.example"),
    );
    expect(c).not.toContain("up");
    // The D14 window opened no earlier than the run itself.
    expect(harness.appLogsFrom.length).toBeGreaterThan(0);
  });

  test("secrets from the identity flow are never serialized", async () => {
    const root = probeRoot();
    const harness = makeFakeHarness({
      remoteLogs: `${REPRODUCED_MARKER}\n`,
      remoteBody: `${REPRODUCED_MARKER}\n`,
      workload: { code: 0, stdout: "", stderr: "" },
    });
    const result = await cli(
      root,
      ["run", "remmy", "--env", "dev"],
      harness.deps,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("fake-secret-token");
    for (const [file, content] of Object.entries(
      snapshotTree(root, [".local-platform", ".ass"]),
    )) {
      expect({ file, leaked: content.includes("fake-secret-token") }).toEqual({
        file,
        leaked: false,
      });
    }
  });

  test("conflicting channel verdicts are inconclusive (exactly-once, D11)", async () => {
    const root = probeRoot();
    const harness = makeFakeHarness({
      remoteLogs: `${REPRODUCED_MARKER}\n`,
      remoteBody: `${HEALTHY_MARKER}\n`,
      workload: { code: 0, stdout: "", stderr: "" },
    });
    const result = await cli(
      root,
      ["run", "remmy", "--env", "dev"],
      harness.deps,
    );
    expect(result.code).toBe(3);
    expect(result.stdout).toContain("conflicting");
  });

  test("zero in-window markers end inconclusive, never not-reproduced", async () => {
    const root = probeRoot();
    const harness = makeFakeHarness({
      remoteLogs: "just noise, the probe said nothing\n",
      remoteBody: "also nothing\n",
      workload: { code: 0, stdout: "", stderr: "" },
    });
    const before = Date.now();
    const result = await cli(
      root,
      ["run", "remmy", "--env", "dev"],
      harness.deps,
    );
    expect(result.code).toBe(3);
    expect(result.stdout).toContain("emitted no ASS-VERDICT");
    // The pull was bounded to the workload's own window (D14): --from is
    // the workload start, not "the last 10 minutes".
    for (const fromMs of harness.appLogsFrom) {
      expect(fromMs).toBeGreaterThanOrEqual(before);
    }
  });

  test("an incomplete teardown names the leaked app; the verdict survives", async () => {
    const root = probeRoot();
    const harness = makeFakeHarness({
      remoteLogs: `${REPRODUCED_MARKER}\n`,
      remoteBody: `${REPRODUCED_MARKER}\n`,
      workload: { code: 0, stdout: "", stderr: "" },
      failRemoteDelete: "registry said 502",
    });
    const result = await cli(
      root,
      ["run", "remmy", "--env", "dev"],
      harness.deps,
    );
    expect(result.code).toBe(0); // the outcome stands; cleanup is reported
    expect(result.stdout).toContain("leaked probe app fake-ns/probe");
    expect(result.stdout).toContain("registry said 502");
  });

  test("a failing deploy is a reported setup failure", async () => {
    const root = probeRoot();
    const harness = makeFakeHarness({
      failRemoteDeploy: "namespace quota exceeded",
    });
    const result = await cli(
      root,
      ["run", "remmy", "--env", "dev"],
      harness.deps,
    );
    expect(result.code).toBe(4);
    expect(result.stdout).toContain("setup-failed");
    expect(result.stdout).toContain("namespace quota exceeded");
    expect(harness.calls.some((c) => c.startsWith("exec:"))).toBe(false);
  });

  test("config.max_instances > 1 fails preflight naming fixture and target", async () => {
    const root = probeRoot(
      REMOTE_PROBE_TOML.replace(
        "config = { max_instances = 1 }",
        "config = { max_instances = 3 }",
      ),
    );
    const harness = makeFakeHarness();
    const result = await cli(
      root,
      ["run", "remmy", "--env", "dev"],
      harness.deps,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('fixture "matrix"');
    expect(result.stdout).toContain("max_instances: 3");
    expect(result.stdout).toContain('"dev"');
    expect(harness.calls).toEqual([]); // before any fixture work
  });

  test("a platform-process predicate fails preflight before fixture work", async () => {
    const root = makeRoot();
    addScenario(root, "repros", "edgy", PERSISTED_TOML);
    const harness = makeFakeHarness();
    const result = await cli(
      root,
      ["run", "edgy", "--env", "dev"],
      harness.deps,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('"edge"');
    expect(result.stdout).toContain('"dev"');
    expect(harness.calls).toEqual([]);
  });

  test("remote app-instance log predicates read the D14 capture", async () => {
    const root = probeRoot(`
[meta]
id = "RM-2"
title = "remote log_matches scenario"
lifecycle = { state = "open" }

[fixtures.probes.matrix]
source = "package:./probe"

[load]
executor = "artillery-http"

[load.artillery-http]
target = "{{ matrix.url }}"
scenarios = [{ flow = [{ get = { url = "/" } }] }]

[[verdict.reproduced_when.any]]
log_matches = { stream = "app", pattern = "deadlock detected" }

[verdict.baseline]
waived = "no native analogue"
`);
    const harness = makeFakeHarness({
      remoteLogs: "worker 3: deadlock detected after 30s\n",
      workload: { code: 0, stdout: "", stderr: "" },
    });
    const result = await cli(
      root,
      ["run", "remmy", "--env", "dev"],
      harness.deps,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("reproduced");
    expect(harness.calls).toContain("remote-logs:app");
  });
});

describe("production gates (Phase 5)", () => {
  test("no acknowledgement flag: refuse before anything runs", async () => {
    const root = probeRoot();
    const harness = makeFakeHarness();
    const result = await cli(
      root,
      ["run", "remmy", "--env", "prod"],
      harness.deps,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("--i-know-this-is-prod");
    expect(harness.calls).toEqual([]);
  });

  test("declined confirmation: refuse before any fixture work", async () => {
    const root = probeRoot();
    const harness = makeFakeHarness({ confirmProdAnswer: false });
    const result = await cli(
      root,
      ["run", "remmy", "--env", "prod", "--i-know-this-is-prod"],
      harness.deps,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("not confirmed");
    expect(harness.calls).toEqual(["confirm-prod"]);
  });

  test("a stress profile refuses before the confirmation prompt", async () => {
    const root = probeRoot(
      REMOTE_PROBE_TOML.replace(
        "phases = [{ duration = 1, arrivalCount = 1 }]",
        "phases = [{ duration = 30, arrivalRate = 100 }]",
      ),
    );
    const harness = makeFakeHarness({ confirmProdAnswer: true });
    const result = await cli(
      root,
      ["run", "remmy", "--env", "prod", "--i-know-this-is-prod"],
      harness.deps,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("stress profile");
    expect(result.stdout).toContain(`${PROD_CAPS.arrivalRate}/s`);
    expect(harness.calls).toEqual([]); // no prompt for a doomed run
  });

  test("jest workloads are not qualified for production", async () => {
    const root = makeRoot();
    addScenario(
      root,
      "repros",
      "jesty",
      `
[meta]
id = "RM-3"
title = "jest on prod"
lifecycle = { state = "open" }

[load]
executor = "jest"

[load.jest]
spec = "tests/x.test.ts"

[[verdict.reproduced_when.any]]
output_matches = { pattern = "kaboom" }

[verdict.baseline]
waived = "n/a"
`,
    );
    const harness = makeFakeHarness({ confirmProdAnswer: true });
    const result = await cli(
      root,
      ["run", "jesty", "--env", "prod", "--i-know-this-is-prod"],
      harness.deps,
    );
    expect(result.code).toBe(1);
    // The presenter truncates long lines to the table width; assert the
    // stable prefix.
    expect(result.stdout).toContain("not qualified");
    expect(harness.calls).toEqual([]);
  });

  test("an acknowledged, confirmed, capped run proceeds", async () => {
    const root = probeRoot();
    const harness = makeFakeHarness({
      remoteLogs: `${REPRODUCED_MARKER}\n`,
      remoteBody: `${REPRODUCED_MARKER}\n`,
      workload: { code: 0, stdout: "", stderr: "" },
      confirmProdAnswer: true,
    });
    const result = await cli(
      root,
      ["run", "remmy", "--env", "prod", "--i-know-this-is-prod"],
      harness.deps,
    );
    expect(result.code).toBe(0);
    expect(harness.calls[0]).toBe("confirm-prod");
    expect(harness.calls).toContain("remote-platform:prod");
  });

  test("the caps are fixed constants at their boundaries", () => {
    const scenario = (phases: string): ReturnType<typeof parseScenario> =>
      parseScenario(
        {
          meta: { id: "C-1", title: "caps" },
          load: {
            executor: "artillery-http",
            "artillery-http": {
              target: "https://x.example",
              phases: JSON.parse(phases),
              scenarios: [{ flow: [{ get: { url: "/" } }] }],
            },
          },
        },
        "draft",
      );
    const at = scenario(
      `[{"duration": ${PROD_CAPS.phaseDurationSeconds}, "arrivalRate": ${PROD_CAPS.arrivalRate}}]`,
    );
    expect(() => enforceProdWorkload(at, "artillery-http")).not.toThrow();
    const over = scenario(
      `[{"duration": 1, "arrivalRate": ${PROD_CAPS.arrivalRate + 1}}]`,
    );
    expect(() => enforceProdWorkload(over, "artillery-http")).toThrow(
      PreflightError,
    );
    // Total duration is capped across phases, and "2m"-style strings count.
    const total = scenario(`[{"duration": "2m"}, {"duration": "1m"}]`);
    expect(() => enforceProdWorkload(total, "artillery-http")).toThrow(
      /total load duration/,
    );
    const opaque = scenario(`[{"duration": "until dawn"}]`);
    expect(() => enforceProdWorkload(opaque, "artillery-http")).toThrow(
      /unreadable bound is no bound/,
    );
  });

  test("the default confirmation refuses non-interactive contexts", async () => {
    // jest runs without a TTY on stdin, which is exactly the refusal case.
    await expect(defaultProdConfirm("really?")).resolves.toBe(false);
  });
});

describe("remote identity", () => {
  test("a missing identity produces an actionable failure", async () => {
    const { authFailureMessage } = await import("../../ass/fixtures/remote");
    const message = authFailureMessage(
      "dev",
      "Could not find token for registry",
    );
    expect(message).toContain("dev");
    expect(message).toContain("registry.wasmer.wtf");
    expect(message).toContain("WASMER_TOKEN");
    expect(message).toContain("wasmer login --registry");
    expect(message).not.toContain("/graphql'"); // login takes the bare host
  });
});

describe("the D14 quiescence window", () => {
  test("polls until the log stays flat, then closes the window", async () => {
    let clockMs = 1_000;
    const pulls: string[] = ["a", "ab", "ab", "ab", "abc-too-late"];
    let pullCount = 0;
    const platform: RemotePlatform = {
      registry: "r",
      namespace: "n",
      execEnv: () => ({}),
      deployPackageApp: () => Promise.reject(new Error("unused")),
      deleteApp: () => Promise.resolve(),
      appLogs: async () => pulls[Math.min(pullCount++, pulls.length - 1)],
      fetchBody: () => Promise.reject(new Error("unused")),
    };
    const dir = makeRoot();
    const state = {
      env: "dev",
      variables: {},
      components: {},
      pins: {},
      execEnv: {},
      artifactsDir: dir,
      composeLogPath: null,
      cleanup: async () => [],
      remote: {
        platform,
        deployed: {
          matrix: { ident: "n/m", id: "da_m", url: "https://m.example" },
        },
      },
    } as ResolvedState;
    const scenario = parseScenario(
      {
        meta: { id: "Q-1", title: "quiescence" },
        load: {
          executor: "artillery-http",
          "artillery-http": {
            target: "https://m.example",
            scenarios: [{ flow: [{ get: { url: "/" } }] }],
          },
        },
        verdict: {
          probe: { channels: [{ type: "log", stream: "stderr" }] },
          baseline: { waived: "n/a" },
        },
      },
      "draft",
    );
    const { captures, appStreamFiles } = await captureRemote(
      scenario,
      state,
      [{ channel: { type: "log", stream: "stderr" }, source: "app-logs" }],
      {
        workloadStartMs: 500,
        quiescenceMs: 10,
        maxWaitMs: 1_000,
        pollMs: 5,
        now: () => clockMs,
        sleep: async (ms) => {
          clockMs += ms;
        },
      },
    );
    // Growth at pull 2 reset the quiescence clock; two flat pulls closed the
    // window. The post-close growth ("abc-too-late") was never read.
    expect(pullCount).toBe(4);
    const captured = readFileSync(captures["log:stderr"], "utf8");
    expect(captured).toContain("ab");
    expect(captured).not.toContain("abc-too-late");
    const sources = remoteStreamSources(appStreamFiles);
    expect(sources.read("stderr")).not.toBeNull();
    expect(sources.read("edge")).toBeNull();
  });
});
