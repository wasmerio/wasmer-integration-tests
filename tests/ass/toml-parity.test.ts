// D-7 (phase 2, AC-3): the YAML→TOML swap is a pure format change. Each
// expected object below is what js-yaml produced for the former YAML
// declaration; the TOML fixture must reach the identical zod output.

import { parseScenario } from "../../ass/scenario/schema";
import { parseToml } from "../../ass/scenario/toml";
import { parseDeclaration } from "../../ass/simulator/scenario";
import { PERSISTED_TOML } from "./helpers";

// The former PERSISTED_YAML, as js-yaml parsed it.
const PERSISTED_PARSED = {
  meta: {
    id: "WAX-600",
    title: "Edge wasix cross-Store panic under CPU starvation",
    lifecycle: { state: "open" },
    links: { linear: "https://linear.app/wasmer/issue/WAX-600" },
  },
  fixtures: {
    apps: { victim: { source: "template:next-react-server-components" } },
    components: {
      edge: "github-release:wasmerio/edge:v2026-07-16_1_fcdd9c4_dev1:edge",
      backend:
        "github-release:wasmerio/backend:v2026-07-15_2_9a6c3d4:*image*.tar*",
    },
    perturbations: {
      edge: { cpus: 1, wipe_caches: ["compiler_cache", "webc_cache"] },
    },
  },
  load: {
    executor: "jest",
    jest: {
      spec: "tests/app/templates.test.ts",
      testNamePattern: "next-react-server-components",
    },
  },
  verdict: {
    reproduced_when: {
      any: [
        {
          log_matches: {
            stream: "edge",
            pattern: "object used with the wrong context",
          },
        },
      ],
    },
    baseline: { waived: "platform-level bug - no native analogue" },
  },
};

// The former simulator v1 YAML (billing shape), as js-yaml parsed it.
const SIMULATOR_TOML = `
assSchema = 1
name = "t-parity"
seed = 9
account = { username = "u", password = "p", namespace = "n" }

[apps]
count = 4
disks = { attached = 3, sizes = ["1G", "10G"] }

[billing]
plan = "scale"
subscription = "past_due"
invoices = { count = 14, failed = 2 }
`;

// The zod output the former YAML equivalent produced (defaults applied;
// assSchema=1 declarations are auto-upgraded to the current schema).
const SIMULATOR_EXPECTED = {
  assSchema: 2,
  name: "t-parity",
  seed: 9,
  account: { username: "u", password: "p", namespace: "n", pinned: true },
  apps: {
    count: 4,
    fixture: "static-site",
    disks: { attached: 3, sizes: ["1G", "10G"] },
  },
  billing: {
    plan: "scale",
    subscription: "past_due",
    invoices: { count: 14, failed: 2 },
  },
};

test("an ASS scenario TOML parses to the identical zod output (AC-3)", () => {
  const fromToml = parseScenario(
    parseToml(PERSISTED_TOML, "fixture"),
    "persisted",
  );
  const fromYamlEquivalent = parseScenario(PERSISTED_PARSED, "persisted");
  expect(fromToml).toEqual(fromYamlEquivalent);
});

test("a simulator declaration TOML parses to the identical zod output (AC-3)", () => {
  expect(parseDeclaration(SIMULATOR_TOML, "fixture.toml")).toEqual(
    SIMULATOR_EXPECTED,
  );
});
