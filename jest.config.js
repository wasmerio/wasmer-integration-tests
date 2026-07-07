/** @type {import('ts-jest').JestConfigWithTsJest} **/
export default {
  globalSetup: "./jest-global-setup.ts",
  testEnvironment: "<rootDir>/tests/utils/preserve-failing-apps-environment.js",
  // Most of the wait is network-bound, nothing computationally heavy. The
  // percentage collapses to a single worker on small CI runners, so CI sets
  // JEST_MAX_WORKERS explicitly (see local-platform/scripts/local-test.sh).
  maxWorkers: process.env.JEST_MAX_WORKERS || "30%",
  // Concurrency cap for test.concurrent within a single file (jest default 5).
  // Overridable for experiments; raising it increases concurrent deploys and
  // can overwhelm small runners hosting the co-resident local platform stack.
  maxConcurrency: Number(process.env.JEST_MAX_CONCURRENCY || 5),
  silent: true,
  // Hard per-spec ceiling: no single test may run longer than 30 minutes. If it
  // does, jest fails it. Individual files may set a *stricter* limit via
  // jest.setTimeout (e.g. ssh/sdk at 10m, wasmopticon at 20m); none may exceed
  // this. Complemented by the per-suite job timeout in local-platform-suite.yaml.
  testTimeout: 1_800_000,
  // Integration tests spawn child processes (pnpm/vite/wasmer) and open
  // websockets for deploy progress. When a test times out those handles can
  // outlive it and keep the event loop alive, so without forceExit jest hangs
  // after the run instead of exiting — which let the templates suite sit for
  // ~52 minutes. forceExit guarantees the process terminates once specs settle.
  forceExit: true,
  transform: {
    "^.+.tsx?$": ["ts-jest", {}],
  },
  setupFilesAfterEnv: ["./jest-logging-config.ts"],
  reporters: ["default", "<rootDir>/tests/utils/failures-only-reporter.js"],
};
