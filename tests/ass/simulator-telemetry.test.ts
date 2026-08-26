// Traffic-model units: the deterministic traffic model (the source of the
// seeded e2e's exact-value assertions), the 5xx stripe's exact count, and
// the D-B drift assertion's failure message.

import { parseDeclaration } from "../../ass/simulator/scenario";
import {
  expandTraffic,
  resolvePerAppMultipliers,
  serverSideErrorCount,
  splitCount,
  type TrafficTelemetry,
} from "../../ass/simulator/traffic";
import { appNames } from "../../ass/simulator/names";
import { SimulatorClickHouse } from "../../ass/simulator/clients/clickhouse";
import { seededRandom } from "../../ass/simulator/random";

const TELEMETRY_TOML = (extra = ""): string =>
  [
    "assSchema = 1",
    'name = "t-tele"',
    "seed = 4242",
    'account = { username = "u", password = "p", namespace = "n" }',
    "apps = { count = 3 }",
    "[telemetry]",
    'history = "10d"',
    'rawWindow = "3h"',
    extra,
    "[telemetry.rps]",
    "base = 2",
    'spikes = [{ at = "-3d", multiplier = 8, duration = "2h" }]',
    "[telemetry.errorRate]",
    "base = 0.004",
    'bursts = [{ at = "-1d", rate = 0.2, duration = "1h" }]',
  ].join("\n");

/** The declaration's telemetry block in the model's input shape (the
 * upgraded declaration spells the raw window `precision.raw`). */
function trafficShape(toml: string): TrafficTelemetry {
  const telemetry = parseDeclaration(toml, "t.toml").telemetry!;
  return {
    history: telemetry.history,
    rawWindow: telemetry.precision.raw,
    rps: telemetry.rps as TrafficTelemetry["rps"],
    errorRate: telemetry.errorRate as TrafficTelemetry["errorRate"],
    resources: telemetry.resources as TrafficTelemetry["resources"],
  };
}

describe("traffic model", () => {
  const telemetry = trafficShape(TELEMETRY_TOML());
  const NOW = Date.UTC(2026, 7, 14, 12, 30);

  test("same seed and time ⇒ identical model; different seed diverges", () => {
    const a = expandTraffic(telemetry, 4242, 3, NOW);
    const b = expandTraffic(telemetry, 4242, 3, NOW);
    expect(a.daily).toEqual(b.daily);
    expect(a.totalRequests).toBe(b.totalRequests);
    const c = expandTraffic(telemetry, 999, 3, NOW);
    expect(c.totalRequests).not.toBe(a.totalRequests);
  });

  test("daily projections sum to the total; spike day dominates", () => {
    const model = expandTraffic(telemetry, 4242, 3, NOW);
    expect(model.daily.reduce((sum, day) => sum + day.requests, 0)).toBe(
      model.totalRequests,
    );
    const spikeDay = model.daily.find((day) => day.date === "2026-08-11");
    const quietDay = model.daily.find((day) => day.date === "2026-08-09");
    expect(spikeDay!.requests).toBeGreaterThan(quietDay!.requests * 1.4);
  });

  test("burst day carries a visibly elevated 5xx share", () => {
    const model = expandTraffic(telemetry, 4242, 3, NOW);
    const burstDay = model.daily.find((day) => day.date === "2026-08-13")!;
    const normalDay = model.daily.find((day) => day.date === "2026-08-09")!;
    expect(burstDay.http5xx / burstDay.requests).toBeGreaterThan(
      (3 * normalDay.http5xx) / normalDay.requests,
    );
  });

  test("raw window bounds raw rows; hours flagged consistently", () => {
    const model = expandTraffic(telemetry, 4242, 3, NOW);
    const rawHours = model.hours.filter((hour) => hour.raw);
    expect(rawHours.length).toBeLessThanOrEqual(4);
    expect(rawHours.reduce((sum, hour) => sum + hour.count, 0)).toBe(
      model.rawRequests,
    );
  });

  test("splitCount preserves exact totals for any weights", () => {
    const random = seededRandom(7);
    for (let round = 0; round < 50; round++) {
      const weights = Array.from({ length: 5 }, () => 0.4 + random.next());
      const sum = weights.reduce((total, weight) => total + weight, 0);
      const normalized = weights.map((weight) => weight / sum);
      const total = random.int(0, 100_000);
      const parts = splitCount(total, normalized);
      expect(parts.reduce((totalPart, part) => totalPart + part, 0)).toBe(
        total,
      );
    }
  });

  test("per-app hourly counts sum to the hour and day totals", () => {
    const model = expandTraffic(telemetry, 4242, 3, NOW);
    for (const hour of model.hours) {
      expect(hour.perApp).toHaveLength(3);
      expect(hour.perApp.reduce((sum, part) => sum + part, 0)).toBe(hour.count);
    }
  });

  test("a per-app multiplier doubles exactly that app, no others", () => {
    const baseline = expandTraffic(telemetry, 4242, 3, NOW);
    const surged = expandTraffic(telemetry, 4242, 3, NOW, [1, 2, 1]);
    baseline.hours.forEach((hour, index) => {
      const after = surged.hours[index];
      expect(after.perApp[0]).toBe(hour.perApp[0]);
      expect(after.perApp[1]).toBe(hour.perApp[1] * 2);
      expect(after.perApp[2]).toBe(hour.perApp[2]);
    });
    const appShare = baseline.hours.reduce(
      (sum, hour) => sum + hour.perApp[1],
      0,
    );
    expect(surged.totalRequests).toBe(baseline.totalRequests + appShare);
    expect(surged.daily.reduce((sum, day) => sum + day.requests, 0)).toBe(
      surged.totalRequests,
    );
  });

  test("all-ones multipliers reproduce the unmodified model", () => {
    const baseline = expandTraffic(telemetry, 4242, 3, NOW);
    const explicit = expandTraffic(telemetry, 4242, 3, NOW, [1, 1, 1]);
    expect(explicit.hours).toEqual(baseline.hours);
    expect(explicit.daily).toEqual(baseline.daily);
    expect(explicit.workloadHours).toEqual(baseline.workloadHours);
  });

  test("perApp names resolve by app name; unknown names refuse loudly", () => {
    const names = appNames(seededRandom(4242).fork("fabricated-names"), 3);
    expect(resolvePerAppMultipliers({}, names)).toBeUndefined();
    expect(resolvePerAppMultipliers({ [names[2]]: 3 }, names)).toEqual([
      1, 1, 3,
    ]);
    expect(() => resolvePerAppMultipliers({ "no-such-app": 2 }, names)).toThrow(
      names.join(", "),
    );
  });

  test("stripe error count is exact for cycles and tails", () => {
    expect(serverSideErrorCount({ count: 2500, errPermille: 4 })).toBe(
      2 * 4 + 4,
    );
    expect(serverSideErrorCount({ count: 999, errPermille: 4 })).toBe(4);
    expect(serverSideErrorCount({ count: 2, errPermille: 4 })).toBe(2);
    expect(serverSideErrorCount({ count: 0, errPermille: 4 })).toBe(0);
  });
});

// The row-budget refusal moved with the engine: summarizeExpansion throws
// ExpansionError naming the knobs - pinned in simulator-engine.test.ts.

describe("schema drift (D-B)", () => {
  test("assertColumns names table, delta, and generating source", async () => {
    const clickhouse = new SimulatorClickHouse({
      LOCAL_PLATFORM_CLICKHOUSE_URL: "http://localhost:18123",
    });
    jest
      .spyOn(clickhouse, "describeTable")
      .mockResolvedValue(new Map([["node_id", "UUID"]]));
    await expect(
      clickhouse.assertColumns("request_log", {
        node_id: "UUID",
        workload_id: "UUID",
        received_at: "DateTime64(3)",
      }),
    ).rejects.toThrow(
      /request_log\.workload_id.*request_log\.received_at.*migrations\.rs/s,
    );
  });

  test("a retyped column is reported distinctly", async () => {
    const clickhouse = new SimulatorClickHouse({
      LOCAL_PLATFORM_CLICKHOUSE_URL: "http://localhost:18123",
    });
    jest
      .spyOn(clickhouse, "describeTable")
      .mockResolvedValue(new Map([["app_id", "String"]]));
    await expect(
      clickhouse.assertColumns("request_log", { app_id: "UInt64" }),
    ).rejects.toThrow(/retyped column request_log\.app_id: live String/);
  });

  test("the guard refuses a non-loopback ClickHouse URL at construction", () => {
    expect(
      () =>
        new SimulatorClickHouse({
          LOCAL_PLATFORM_CLICKHOUSE_URL: "http://clickhouse.prod.internal:8123",
        }),
    ).toThrow(/not loopback/);
  });
});
