/** @type {import('ts-jest').JestConfigWithTsJest} **/
export default {
  globalSetup: "./jest-global-setup.ts",
  testEnvironment: "node",
  // Max it! Most of the wait is in network block, nothing computationally heavy
  maxWorkers: "30%",
  silent: true,
  testTimeout: 180000,
  transform: {
    "^.+.tsx?$": ["ts-jest", {}],
  },
  setupFilesAfterEnv: ["./jest-logging-config.ts"],
  reporters: ["default", "<rootDir>/tests/utils/failures-only-reporter.js"],
};
