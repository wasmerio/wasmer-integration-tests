import nodeConsole from "console";

if (process.env.VERBOSE === "true") {
  // Allow opting into streaming logs to stdout/stderr for debugging.
  global.console = nodeConsole;
}
