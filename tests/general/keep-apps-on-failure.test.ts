import { flushPendingAppCleanups } from "../../src/env";

const PENDING_KEY = Symbol.for("wasmer-integration-tests.pending-app-cleanups");
const FAILED_KEY = Symbol.for(
  "wasmer-integration-tests.failed-jest-test-names",
);

type Decision = { id: string; preserve: boolean };

function stubEntry(id: string, testNames: string[], sink: Decision[]) {
  return {
    env: {
      finalizeAppCleanup: async (app: { id: string }, preserve: boolean) => {
        sink.push({ id: app.id, preserve });
      },
    },
    app: { id },
    testNames,
  };
}

test("flush preserves failed-test apps and deletes passed-test apps", async () => {
  const decisions: Decision[] = [];
  const g = globalThis as unknown as Record<symbol, unknown>;

  g[FAILED_KEY] = new Set<string>(["suite fails-here"]);
  g[PENDING_KEY] = [
    stubEntry("app-failed", ["suite fails-here"], decisions),
    stubEntry("app-passed", ["suite passes-here"], decisions),
  ];

  await flushPendingAppCleanups();

  const byId = Object.fromEntries(decisions.map((d) => [d.id, d.preserve]));
  expect(byId["app-failed"]).toBe(true);
  expect(byId["app-passed"]).toBe(false);
  // Queue drained.
  expect((g[PENDING_KEY] as unknown[]).length).toBe(0);
});
