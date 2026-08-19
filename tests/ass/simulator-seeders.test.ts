// Phase 2 seeder units: name determinism, anchor split, the D-K
// connection-time guard on both datastore clients (refusal with zero
// connection attempts), and the ban on unseeded randomness in
// ass/simulator/ (spec §4.1 — every random choice flows through the one
// seeded stream).

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDeclaration } from "../../ass/simulator/schema";
import {
  FIXTURE_NAMES,
  fixturePackage,
  writeFixtureApp,
} from "../../ass/simulator/fixtures";
import {
  assignFixtures,
  normalizeFixtureMix,
} from "../../ass/simulator/seeders/apps";
import { accountKind } from "../../ass/simulator/kinds";
import { seededRandom } from "../../ass/simulator/random";
import { appNames } from "../../ass/simulator/names";
import { anchorCount, ANCHOR_LIMIT } from "../../ass/simulator/seeders/apps";
import { SimulatorBackend } from "../../ass/simulator/clients/graphql";
import { connectSimulatorPostgres } from "../../ass/simulator/clients/postgres";
import { GuardRefusalError } from "../../ass/simulator/guard";

describe("deterministic app names", () => {
  test("same seed, same names; distinct and index-stable", () => {
    const a = appNames(seededRandom(1337), 200);
    const b = appNames(seededRandom(1337), 200);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(200);
    // Growing the count never renames earlier apps (stable prefixes).
    expect(appNames(seededRandom(1337), 5)).toEqual(a.slice(0, 5));
  });

  test("different seeds diverge", () => {
    expect(appNames(seededRandom(1), 5)).not.toEqual(
      appNames(seededRandom(2), 5),
    );
  });
});

describe("anchor split (D-D)", () => {
  test("small portfolios are all real; scale portfolios cap at the limit", () => {
    expect(anchorCount(3)).toBe(3);
    expect(anchorCount(12)).toBe(12);
    expect(anchorCount(200)).toBe(ANCHOR_LIMIT);
  });
});

describe("connection-time guard (D-K layer two)", () => {
  test("GraphQL client refuses a non-loopback registry at construction", () => {
    expect(
      () => new SimulatorBackend("https://registry.wasmer.io/graphql"),
    ).toThrow(GuardRefusalError);
  });

  test("Postgres factory refuses a non-loopback URL before connecting", async () => {
    await expect(
      connectSimulatorPostgres({
        LOCAL_PLATFORM_POSTGRES_URL:
          "postgresql://u:p@db.prod.internal:5432/wapm",
      }),
    ).rejects.toThrow(GuardRefusalError);
  });

  test("no override mechanism exists: guard.ts reads no env flags", () => {
    const source = readFileSync(
      path.join(__dirname, "../../ass/simulator/guard.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/process\.env/);
  });
});

describe("unseeded randomness ban (spec §4.1)", () => {
  test("no Math.random anywhere under ass/simulator/", () => {
    const root = path.join(__dirname, "../../ass/simulator");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".ts")) {
          files.push(full);
        }
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      expect({
        file,
        hasMathRandom: /Math\.random/.test(readFileSync(file, "utf8")),
      }).toEqual({ file, hasMathRandom: false });
    }
  });
});

describe("weighted fixture mix", () => {
  const MIX = { "static-site": 10, php: 1, python: 3 } as const;

  test("normalization is order-independent and sums to 1", () => {
    const mix = normalizeFixtureMix(MIX);
    expect(mix.map((entry) => entry.fixture)).toEqual([
      "static-site",
      "php",
      "python",
    ]);
    expect(mix.reduce((sum, entry) => sum + entry.weight, 0)).toBeCloseTo(
      1,
      10,
    );
    expect(normalizeFixtureMix("php")).toEqual([{ fixture: "php", weight: 1 }]);
  });

  test("assignment has exact per-fixture counts and is seed-deterministic", () => {
    const a = assignFixtures(MIX, 14, seededRandom(1337));
    const b = assignFixtures(MIX, 14, seededRandom(1337));
    expect(a).toEqual(b);
    expect(a).toHaveLength(14);
    const count = (fixture: string): number =>
      a.filter((assigned) => assigned === fixture).length;
    // Largest-remainder over normalized 10/1/3 of 14 = exactly 10/1/3.
    expect(count("static-site")).toBe(10);
    expect(count("php")).toBe(1);
    expect(count("python")).toBe(3);
    // The shuffle spreads the mix into the anchor prefix rather than
    // letting the heaviest fixture monopolize it.
    expect(new Set(a.slice(0, 12)).size).toBeGreaterThan(1);
    expect(assignFixtures(MIX, 14, seededRandom(9))).not.toEqual(a);
  });

  test("schema accepts a mix, refuses unknown names and empty mixes", () => {
    const base = (fixture: string): string =>
      [
        "assSchema: 1",
        "name: t-mix",
        "account: { username: u, password: p, namespace: n }",
        "apps:",
        "  count: 4",
        `  fixture: ${fixture}`,
      ].join("\n");
    const parsed = parseDeclaration(
      base("{ static-site: 10, php: 1, python: 3 }"),
      "t.yaml",
    );
    expect(typeof parsed.apps?.fixture).toBe("object");
    expect(
      () =>
        base("{ cobol: 1 }") &&
        parseDeclaration(base("{ cobol: 1 }"), "t.yaml"),
    ).toThrow();
    expect(() => parseDeclaration(base("{}"), "t.yaml")).toThrow();
    expect(() => parseDeclaration(base("cobol"), "t.yaml")).toThrow();
  });

  test("every registered fixture materializes a deployable app dir", () => {
    for (const fixture of FIXTURE_NAMES) {
      const dir = mkdtempSync(path.join(tmpdir(), "sim-fixture-"));
      writeFixtureApp(fixture, dir, "test-app", "test-ns");
      const toml = readFileSync(path.join(dir, "wasmer.toml"), "utf8");
      expect(toml).toContain(fixturePackage(fixture).split("/")[0]);
      expect(readFileSync(path.join(dir, "app.yaml"), "utf8")).toContain(
        "name: test-app",
      );
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pinned account (the superuser lens)", () => {
  test("account.pinned defaults true; e2e-style opt-out parses", () => {
    const yaml = (extra = ""): string =>
      [
        "assSchema: 1",
        "name: t-pin",
        `account: { username: u, password: p, namespace: n${extra} }`,
      ].join("\n");
    expect(parseDeclaration(yaml(), "t.yaml").account.pinned).toBe(true);
    expect(
      parseDeclaration(yaml(", pinned: false"), "t.yaml").account.pinned,
    ).toBe(false);
  });

  test("teardown keeps a pinned identity and deletes nothing", async () => {
    const kept: string[] = [];
    const errors = await accountKind.down(
      {
        kind: "account",
        username: "local-dev-user",
        namespace: "localdev",
        userId: "u_x",
        namespaceId: "ns_x",
        createdNamespace: true,
        pinned: true,
      },
      {
        repoDir: "/tmp",
        // env deliberately null: a pinned keep must not need (or touch)
        // any backend/datastore connection.
        env: null,
        driver: {} as never,
        io: { out: () => undefined, err: (line) => kept.push(line) },
        verbose: false,
      },
    );
    expect(errors).toEqual([]);
    expect(kept.join("\n")).toContain("kept (pinned)");
  });
});
