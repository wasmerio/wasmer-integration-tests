import type { AppInfo, AppTemplate } from "../../src/backend";
import type { TestEnv } from "../../src/index";

import { deployAndValidateTemplate, shardTemplates } from "./template-deploy";

function templates(...slugs: string[]): AppTemplate[] {
  return slugs.map((slug) => ({ name: slug, slug }));
}

describe("shardTemplates", () => {
  test("returns all templates when sharding is disabled", () => {
    const input = templates("b", "a");

    expect(shardTemplates(input)).toBe(input);
  });

  test("partitions templates deterministically without gaps or overlap", () => {
    const input = templates(
      "m",
      "a",
      "f",
      "c",
      "l",
      "d",
      "j",
      "b",
      "k",
      "e",
      "i",
      "g",
      "h",
    );

    const shards = Array.from({ length: 6 }, (_, index) =>
      shardTemplates(input, String(index + 1), "6"),
    );
    const assignedSlugs = shards.flat().map((template) => template.slug);

    expect(shards.map((shard) => shard.length)).toEqual([3, 2, 2, 2, 2, 2]);
    expect(new Set(assignedSlugs).size).toBe(input.length);
    expect(assignedSlugs.sort()).toEqual(
      input.map((template) => template.slug).sort(),
    );
    expect(shards[0].map((template) => template.slug)).toEqual(["a", "g", "m"]);
  });

  test.each([
    ["1", undefined, "must be set together"],
    [undefined, "6", "must be set together"],
    ["0", "6", "TEMPLATE_SHARD_INDEX must be a positive integer"],
    ["1", "nope", "TEMPLATE_SHARD_COUNT must be a positive integer"],
    ["7", "6", "must not exceed"],
  ])(
    "rejects invalid shard configuration index=%s count=%s",
    (index, count, message) => {
      expect(() => shardTemplates(templates("a"), index, count)).toThrow(
        message,
      );
    },
  );
});

// Cleanup contract for deployAndValidateTemplate: an app that exists
// server-side when a step fails must flow through the preserve-aware
// env.deleteApp() queue, never an unconditional `wasmer app delete`.
// Deleting such an app destroys the evidence needed to investigate
// deploy-then-unreachable failures (QA-599).
describe("deployAndValidateTemplate cleanup", () => {
  const template: AppTemplate = { name: "demo", slug: "demo" };

  interface StubOptions {
    deployFails?: boolean;
    appGetFails?: boolean;
  }

  interface StubCalls {
    rawDeletes: string[][];
    queuedDeletes: AppInfo[];
    recorded: unknown[];
  }

  function stubEnv(options: StubOptions): { env: TestEnv; calls: StubCalls } {
    const calls: StubCalls = {
      rawDeletes: [],
      queuedDeletes: [],
      recorded: [],
    };
    const env = {
      namespace: "test-namespace",
      edgeServer: undefined,
      runWasmerCommand: async ({ args }: { args: string[] }) => {
        const command = args.slice(0, 2).join(" ");
        if (command.startsWith("deploy") && options.deployFails) {
          throw new Error("App still not reachable after 5 minutes...");
        }
        if (command === "app get") {
          if (options.appGetFails) {
            throw new Error("Unable to query app");
          }
          return {
            stdout: JSON.stringify({
              id: "da_stub",
              name: args[2].split("/")[1],
              url: "https://stub.wasmer.app",
              active_version: { id: "dav_stub" },
            }),
          };
        }
        if (command === "app delete") {
          calls.rawDeletes.push(args);
        }
        return { stdout: "" };
      },
      deleteApp: async (app: AppInfo) => {
        calls.queuedDeletes.push(app);
      },
      recordDeployedApp: async (input: unknown) => {
        calls.recorded.push(input);
      },
      fetchApp: async () => ({ status: 200, body: null }),
    };
    return { env: env as unknown as TestEnv, calls };
  }

  test("passing deploy routes cleanup through the preserve-aware queue", async () => {
    const { env, calls } = stubEnv({});

    await deployAndValidateTemplate(env, template);

    expect(calls.queuedDeletes).toHaveLength(1);
    expect(calls.rawDeletes).toHaveLength(0);
  });

  test("unreachable-after-deploy failure preserves the created app", async () => {
    const { env, calls } = stubEnv({ deployFails: true });

    await expect(deployAndValidateTemplate(env, template)).rejects.toThrow(
      "not reachable",
    );

    // The app exists server-side, so it must be recovered, recorded for the
    // failure report, and queued (where a failed test preserves it) — never
    // deleted directly.
    expect(calls.queuedDeletes).toHaveLength(1);
    expect(calls.queuedDeletes[0].id).toBe("da_stub");
    expect(calls.recorded).toHaveLength(1);
    expect(calls.rawDeletes).toHaveLength(0);
  });

  test("app invisible to `app get` after failure is swept up directly", async () => {
    const { env, calls } = stubEnv({ deployFails: true, appGetFails: true });

    await expect(deployAndValidateTemplate(env, template)).rejects.toThrow(
      "not reachable",
    );

    expect(calls.queuedDeletes).toHaveLength(0);
    expect(calls.recorded).toHaveLength(0);
    expect(calls.rawDeletes).toHaveLength(1);
    expect(calls.rawDeletes[0][2]).toMatch(/^test-namespace\/t-/);
  });
});
