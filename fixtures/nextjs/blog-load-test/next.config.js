/** @type {import('next').NextConfig} */
module.exports = {
  output: "standalone",
  // Silence Next's workspace-root inference warning: this fixture is deployed
  // as a standalone copy, but during local iteration it sits nested inside
  // the wasmer-integration-tests checkout, which has its own lockfile.
  turbopack: {
    root: __dirname,
  },
};
