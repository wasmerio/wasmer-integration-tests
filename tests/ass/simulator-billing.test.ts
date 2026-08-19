// Phase 4 units: plan/state mapping, invoice synthesis rules, the D-K
// guard on the billing path, and the reseed-after-partial-down regression
// (a descriptor with any done entry must never no-op).

import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseDeclaration } from "../../ass/simulator/schema";
import { billingSeeder } from "../../ass/simulator/seeders/billing";
import { seededRandom } from "../../ass/simulator/random";
import { connectSimulatorPostgres } from "../../ass/simulator/clients/postgres";
import { GuardRefusalError } from "../../ass/simulator/guard";
import { runCli } from "../../ass/cli";
import { makeRoot } from "./helpers";
import {
  readHeldDescriptor,
  writeHeldDescriptor,
} from "../../ass/simulator/descriptor";

const BILLING_YAML = [
  "assSchema: 1",
  "name: t-bill",
  "seed: 9",
  "account: { username: u, password: p, namespace: n }",
  "billing:",
  "  plan: scale",
  "  subscription: past_due",
  "  invoices: { count: 14, failed: 2 }",
  "  entitlements: { computeConsumed: 0.8 }",
].join("\n");

describe("billing plan()", () => {
  test("summarizes the declared state", () => {
    const declaration = parseDeclaration(BILLING_YAML, "t.yaml");
    const lines = billingSeeder.plan(declaration, {
      seed: 9,
      random: seededRandom(9),
    });
    expect(lines.join("\n")).toContain('plan "scale"');
    expect(lines.join("\n")).toContain("past_due");
    expect(lines.join("\n")).toContain("14 invoices (2 failed)");
    expect(lines.join("\n")).toContain("80% consumed");
  });

  test("absent billing block plans nothing", () => {
    const declaration = parseDeclaration(
      BILLING_YAML.split("\n").slice(0, 4).join("\n"),
      "t.yaml",
    );
    expect(
      billingSeeder.plan(declaration, { seed: 9, random: seededRandom(9) }),
    ).toEqual([]);
  });
});

describe("billing guard (D-K)", () => {
  test("apply refuses a non-loopback Postgres before any synthesis", async () => {
    const declaration = parseDeclaration(BILLING_YAML, "t.yaml");
    await expect(
      billingSeeder.apply(
        declaration,
        {
          repoDir: "/tmp",
          env: {
            LOCAL_PLATFORM_POSTGRES_URL:
              "postgresql://u:p@db.prod.internal:5432/wapm",
            WASMER_REGISTRY: "http://localhost:18000/graphql",
          },
          seed: 9,
          random: seededRandom(9),
          io: { out: () => undefined, err: () => undefined },
          verbose: false,
          ids: { apps: [], namespacePk: 1, userPk: 1 },
        },
        () => undefined,
      ),
    ).rejects.toThrow(GuardRefusalError);
  });

  test("factory refusal precedes any connection attempt", async () => {
    await expect(
      connectSimulatorPostgres({
        LOCAL_PLATFORM_POSTGRES_URL: "postgresql://u:p@10.0.0.5:5432/wapm",
      }),
    ).rejects.toThrow(/not loopback/);
  });
});

describe("reseed after a partial down (regression)", () => {
  test("a descriptor with done entries never reads as already-seeded", async () => {
    const root = makeRoot();
    const yaml = BILLING_YAML.replace("name: t-bill", "name: t-partial");
    const file = path.join(root, "t-partial.yaml");
    writeFileSync(file, yaml);
    const digest = (
      await import("../../ass/simulator/descriptor")
    ).digestDeclaration(yaml);
    writeHeldDescriptor(root, {
      slug: "t-partial",
      mode: "up",
      assSchema: 1,
      scenarioPath: file,
      seed: 9,
      declarationDigest: digest,
      heldAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      ownsPlatform: false,
      teardown: [
        { kind: "fake", done: true },
        { kind: "fake", done: false },
      ],
    });

    const out: string[] = [];
    const err: string[] = [];
    let applied = 0;
    // A v1 descriptor is v1's contract; v2 is the CLI default, so the
    // engine is pinned for this regression row.
    const code = await runCli(
      ["up", "--file", "t-partial.yaml", "--engine", "v1"],
      {
        cwd: root,
        io: { out: (line) => out.push(line), err: (line) => err.push(line) },
        color: false,
        simulatorDeps: {
          driver: {
            repoDir: root,
            applyPins: () => undefined,
            applyCpus: () => undefined,
            wipeCaches: () => undefined,
            restoreFiles: () => [],
            up: async () => undefined,
            down: async () => null,
            currentRunDir: () => "/fake",
            readTestEnv: () => ({
              WASMER_REGISTRY: "http://localhost:18000/graphql",
              LOCAL_PLATFORM_POSTGRES_URL:
                "postgresql://p:p@localhost:15432/wapm",
              LOCAL_PLATFORM_CLICKHOUSE_URL: "http://localhost:18123",
            }),
            readResolvedEnv: () => ({}),
            composeFollowLogPath: () => "/fake/log",
            edgePlatformConfigPath: () => "/fake/config",
          },
          fetchImpl: async () => ({ status: 200 }),
          seeders: [
            {
              block: "account",
              plan: () => [],
              apply: async (_declaration, _ctx, emit) => {
                applied += 1;
                emit({ kind: "fake" });
              },
            },
          ],
          teardownKinds: [{ kind: "fake", down: async () => [] }],
        },
      },
    );
    expect(code).toBe(0);
    // The stale, partially-torn hold was replaced by a fresh seed, not
    // reported as "already seeded".
    expect(out.join("\n")).not.toContain("already seeded");
    expect(applied).toBe(1);
    const descriptor = readHeldDescriptor(root, "t-partial");
    expect(descriptor?.teardown).toEqual([{ done: false, kind: "fake" }]);
  });
});
