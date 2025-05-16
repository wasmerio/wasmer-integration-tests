/** @type {import('ts-jest').JestConfigWithTsJest} **/
export default {
  testEnvironment: "node",
  // Max it! Most of the wait is in network block, nothing computationally heavy
  maxWorkers: "80%",
  silent: true,
  testTimeout: 180000,
  transform: {
    "^.+.tsx?$": ["ts-jest", {}],
  },
};
