/** @type {import('next').NextConfig} */
module.exports = {
  output: "standalone",
  // Prisma's generated client (driver-adapter/wasm engine) and pg use dynamic
  // requires that Next's bundler (and next-bundle's Vercel-style per-route
  // function tracing) mis-trace when left to tree-shake them; keeping them
  // external makes Next copy their node_modules verbatim instead.
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  // The generated Prisma client lives outside node_modules (custom `output`
  // in schema.prisma), so serverExternalPackages' node_modules-name matching
  // doesn't see it - force-include its files (and pg's) in the /api/hit
  // route's trace directly.
  outputFileTracingIncludes: {
    "/api/hit": [
      "./src/generated/prisma/**/*",
      "./node_modules/pg/**/*",
      "./node_modules/@prisma/adapter-pg/**/*",
    ],
  },
};
