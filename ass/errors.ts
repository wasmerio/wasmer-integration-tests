// Error families shared across layers. `PreflightError` lives here rather
// than in the engine because executors raise it too (a missing wasmer binary
// is a preflight fact), and the engine must not become a dependency of the
// executors it dispatches.

/** Something the run cannot do, discovered before any fixture is mutated.
 * Always a D15 usage exit (1), never a setup failure. */
export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}
