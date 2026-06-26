/** @type {import('ts-jest').JestConfigWithTsJest} **/
export default {
  globalSetup: "./jest-global-setup.ts",
  testEnvironment: "<rootDir>/tests/utils/preserve-failing-apps-environment.js",
  // Max it! Most of the wait is in network block, nothing computationally heavy
  maxWorkers: "30%",
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
