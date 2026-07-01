import nodeConsole from "console";

import {
  currentJestTestName,
  flushPendingAppCleanups,
  isVerboseEnabled,
  markCurrentJestTestFailed,
  runWithJestTestState,
} from "./src/env";

if (isVerboseEnabled()) {
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

type JestStateLike = {
  currentTestName?: string;
  testPath?: string;
};

type JestExpectLike = {
  getState(): JestStateLike;
};

type ConsoleMethod = (...args: unknown[]) => void;

const CONSOLE_TEST_MARKER_PREFIX = "[[wasmer-test:";
const CONSOLE_TEST_MARKER_SUFFIX = "]] ";

function currentJestState(fallbackTestName?: string): JestStateLike {
  const maybeGlobal = globalThis as typeof globalThis & {
    expect?: JestExpectLike;
  };
  const state = maybeGlobal.expect?.getState() ?? {};
  const currentTestName =
    fallbackTestName && !state.currentTestName?.endsWith(fallbackTestName)
      ? fallbackTestName
      : (state.currentTestName ?? fallbackTestName);
  return {
    currentTestName,
    testPath: state.testPath,
  };
}

function withCurrentJestState<T>(
  callback: () => T,
  fallbackTestName?: string,
): T {
  return runWithJestTestState(currentJestState(fallbackTestName), callback);
}

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function readUnknownProperty(value: unknown, property: string): unknown {
  if (!isObjectLike(value) || !(property in value)) {
    return undefined;
  }

  try {
    return (value as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

function normalizeThrownValue(error: unknown): unknown {
  if (error instanceof Error || !isObjectLike(error)) {
    return error;
  }

  const constructorName = readUnknownProperty(
    readUnknownProperty(error, "constructor"),
    "name",
  );
  const type = readUnknownProperty(error, "type");
  if (constructorName !== "ErrorEvent" && type !== "error") {
    return error;
  }

  const message = readUnknownProperty(error, "message");
  const nestedError = readUnknownProperty(error, "error");
  const target =
    readUnknownProperty(error, "target") ??
    readUnknownProperty(error, "currentTarget");
  const targetUrl = readUnknownProperty(target, "url");
  const readyState = readUnknownProperty(target, "readyState");

  const details = [
    "A non-Error ErrorEvent was thrown.",
    typeof message === "string" && message ? `message=${message}` : null,
    typeof targetUrl === "string" ? `webSocket.url=${targetUrl}` : null,
    typeof readyState === "number"
      ? `webSocket.readyState=${readyState}`
      : null,
    nestedError instanceof Error
      ? `nestedError=${nestedError.stack ?? nestedError.message}`
      : null,
  ].filter((line): line is string => Boolean(line));

  return new Error(details.join("\n"), { cause: error });
}

function installTestTaggedConsole(): void {
  if (isVerboseEnabled()) {
    return;
  }

  const baseConsole = global.console;
  const taggedConsole = Object.create(baseConsole) as Console;
  const methods: Array<keyof Console> = [
    "debug",
    "error",
    "info",
    "log",
    "warn",
  ];

  for (const method of methods) {
    const original = baseConsole[method];
    if (typeof original !== "function") {
      continue;
    }

    Object.defineProperty(taggedConsole, method, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (...args: unknown[]) => {
        const testName = currentJestTestName();
        if (!testName) {
          (original as ConsoleMethod).apply(baseConsole, args);
          return;
        }

        const marker = `${CONSOLE_TEST_MARKER_PREFIX}${encodeURIComponent(
          testName,
        )}${CONSOLE_TEST_MARKER_SUFFIX}`;
        if (typeof args[0] === "string") {
          (original as ConsoleMethod).call(
            baseConsole,
            `${marker}${args[0]}`,
            ...args.slice(1),
          );
        } else {
          (original as ConsoleMethod).call(baseConsole, marker, ...args);
        }
      },
    });
  }

  global.console = taggedConsole;
}

function wrapTestCallback(fn: unknown, testName?: string): unknown {
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
        (done as (error?: unknown) => void)(normalizeThrownValue(error));
      };

      try {
        return withCurrentJestState(
          () => callback.call(this, wrappedDone),
          testName,
        );
      } catch (error) {
        markCurrentJestTestFailed();
        throw normalizeThrownValue(error);
      }
    };
  }

  return async function wrappedPromiseCallback(
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    try {
      return await withCurrentJestState(
        () => callback.apply(this, args),
        testName,
      );
    } catch (error) {
      markCurrentJestTestFailed();
      throw normalizeThrownValue(error);
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
      throw normalizeThrownValue(error);
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
          throw normalizeThrownValue(error);
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
    return testApi(
      name,
      wrapTestCallback(fn, name) as JestTestCallback,
      timeout,
    );
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

installTestTaggedConsole();

const globalWithJest = globalThis as unknown as {
  expect?: unknown;
  test?: unknown;
  it?: unknown;
};

globalWithJest.expect = wrapExpectApi(globalWithJest.expect);
globalWithJest.test = wrapTestApi(globalWithJest.test);
globalWithJest.it = wrapTestApi(globalWithJest.it);

// Delete apps queued by env.deleteApp() once every test in the file has run.
// Deferring to afterAll (rather than afterEach) keeps this race-free under
// test.concurrent — all failures are recorded before the queue is drained, so
// apps belonging to failed tests are reliably preserved instead of deleted.
const globalWithHooks = globalThis as typeof globalThis & {
  afterAll?: (fn: () => unknown) => void;
};
globalWithHooks.afterAll?.(async () => {
  await flushPendingAppCleanups();
});
