import nodeConsole from "console";

import { markCurrentJestTestFailed } from "./src/env";

if (process.env.VERBOSE === "true") {
  // Allow opting into streaming logs to stdout/stderr for debugging.
  global.console = nodeConsole;
}

type JestTestCallback = (...args: unknown[]) => unknown;
type JestTestApi = ((
  name: string,
  fn?: JestTestCallback,
  timeout?: number,
) => unknown) &
  Record<string, unknown>;

function wrapTestCallback(fn: unknown): unknown {
  if (typeof fn !== "function") {
    return fn;
  }

  const callback = fn as JestTestCallback;

  if (callback.length > 0) {
    return function wrappedDoneCallback(this: unknown, done: unknown): unknown {
      if (typeof done !== "function") {
        return callback.call(this, done);
      }

      const wrappedDone = (error?: unknown): void => {
        if (error) {
          markCurrentJestTestFailed();
        }
        (done as (error?: unknown) => void)(error);
      };

      try {
        return callback.call(this, wrappedDone);
      } catch (error) {
        markCurrentJestTestFailed();
        throw error;
      }
    };
  }

  return async function wrappedPromiseCallback(
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    try {
      return await callback.apply(this, args);
    } catch (error) {
      markCurrentJestTestFailed();
      throw error;
    }
  };
}

const wrappedMatcherObjects = new WeakMap<object, unknown>();

function markAsyncFailure(value: unknown): unknown {
  if (
    value &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function" &&
    "catch" in value &&
    typeof value.catch === "function"
  ) {
    return (value as Promise<unknown>).catch((error: unknown) => {
      markCurrentJestTestFailed();
      throw error;
    });
  }

  return value;
}

function wrapMatcherObject(value: unknown): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }

  const objectValue = value as object;
  const cached = wrappedMatcherObjects.get(objectValue);
  if (cached) {
    return cached;
  }

  const wrapped = new Proxy(objectValue, {
    get(target, property, receiver) {
      const item = Reflect.get(target, property, receiver);
      if (typeof item !== "function") {
        return wrapMatcherObject(item);
      }

      return (...args: unknown[]) => {
        try {
          return markAsyncFailure(item.apply(target, args));
        } catch (error) {
          markCurrentJestTestFailed();
          throw error;
        }
      };
    },
  });
  wrappedMatcherObjects.set(objectValue, wrapped);
  return wrapped;
}

function wrapExpectApi(api: unknown): unknown {
  if (typeof api !== "function") {
    return api;
  }

  return new Proxy(api, {
    apply(target, thisArg, args) {
      return wrapMatcherObject(Reflect.apply(target, thisArg, args));
    },
  });
}

function wrapTestApi(api: unknown): unknown {
  if (typeof api !== "function") {
    return api;
  }

  const testApi = api as JestTestApi;
  const wrapped = function wrappedTestApi(
    name: string,
    fn?: JestTestCallback,
    timeout?: number,
  ): unknown {
    return testApi(name, wrapTestCallback(fn) as JestTestCallback, timeout);
  } as JestTestApi;

  for (const key of Reflect.ownKeys(testApi)) {
    const descriptor = Object.getOwnPropertyDescriptor(testApi, key);
    if (!descriptor) {
      continue;
    }

    if (key === "each" && typeof descriptor.value === "function") {
      const each = descriptor.value as (...args: unknown[]) => unknown;
      Object.defineProperty(wrapped, key, {
        ...descriptor,
        value: (...args: unknown[]) => wrapTestApi(each(...args)),
      });
      continue;
    }

    if (typeof descriptor.value === "function") {
      Object.defineProperty(wrapped, key, {
        ...descriptor,
        value: wrapTestApi(descriptor.value),
      });
      continue;
    }

    Object.defineProperty(wrapped, key, descriptor);
  }

  return wrapped;
}

const globalWithJest = globalThis as unknown as {
  expect?: unknown;
  test?: unknown;
  it?: unknown;
};

globalWithJest.expect = wrapExpectApi(globalWithJest.expect);
globalWithJest.test = wrapTestApi(globalWithJest.test);
globalWithJest.it = wrapTestApi(globalWithJest.it);
