// Executable entry (`pnpm ass …`); kept separate so cli.ts stays import-safe
// for tests.

import process from "node:process";
import { runCli } from "./cli";

// The presenter owns run output; this io only carries the errors raised
// before a table exists (bad slug, bad flag), so it stays unadorned.
runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
