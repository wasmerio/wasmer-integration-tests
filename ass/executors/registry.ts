// Executor dispatch. A load profile's name *is* the executor name, so an
// unknown one is caught here rather than by whichever executor happened to
// be asked last.

import { PreflightError } from "../errors";
import { assertRunOutcome, type Executor } from "./contract";
import { jestExecutor } from "./jest";
import { artilleryHttpExecutor } from "./artilleryHttp";
import { rawWasmerExecutor } from "./rawWasmer";
import { hostProcessExecutor } from "./hostProcess";

const EXECUTORS: Executor[] = [
  jestExecutor,
  artilleryHttpExecutor,
  rawWasmerExecutor,
  hostProcessExecutor,
];

/** Executors a `load:` block may name. `host-process` is reachable only
 * through verdict.baseline / verdict.controls: declaring it as the measured
 * workload would mean the scenario never touches Wasmer at all. */
export const LOAD_EXECUTORS = EXECUTORS.filter(
  (executor) => executor.name !== "host-process",
);

export function findExecutor(name: string): Executor | null {
  return EXECUTORS.find((executor) => executor.name === name) ?? null;
}

export function resolveExecutor(name: string): Executor {
  const executor = LOAD_EXECUTORS.find((candidate) => candidate.name === name);
  if (executor === undefined) {
    const known = LOAD_EXECUTORS.map((candidate) => candidate.name)
      .sort()
      .join(", ");
    throw new PreflightError(
      `unknown executor "${name}"; a load profile's name is the executor ` +
        `that runs it. Known executors: ${known}`,
    );
  }
  return executor;
}

export { assertRunOutcome };
