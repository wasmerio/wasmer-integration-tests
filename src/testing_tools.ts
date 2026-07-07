// Thin wrappers around jest's expect that allow attaching a human-readable
// purpose to the failure. Prefer using expect(...) directly in new code; these
// exist for call sites ported from the Deno test suite.

function withPurpose(purpose: string | undefined, run: () => void): void {
  try {
    run();
  } catch (error) {
    if (purpose && error instanceof Error) {
      error.message = `${purpose}\n${error.message}`;
    }
    throw error;
  }
}

export function assert<T>(isOk: T, purpose?: string): void {
  withPurpose(purpose, () => expect(isOk).toBeTruthy());
}

/**
 * Asserts strict equality (===) of two values, showing both values on failure.
 */
export function assertEquals<T>(a: T, b: T, purpose?: string): void {
  withPurpose(purpose, () => expect(a).toBe(b));
}

/**
 * Asserts strict inequality (!==) of two values.
 */
export function assertNotEquals<T>(a: T, b: T, purpose?: string): void {
  withPurpose(purpose, () => expect(a).not.toBe(b));
}

/**
 * Asserts that every element of `values` is included in `array`.
 */
export function assertArrayIncludes<T>(
  array: T[],
  values: T[],
  purpose?: string,
): void {
  withPurpose(purpose, () =>
    expect(array).toEqual(expect.arrayContaining(values)),
  );
}

/**
 * Asserts that `target` contains `substring`.
 */
export function assertStringIncludes(
  target: string,
  substring: string,
  purpose?: string,
): void {
  withPurpose(purpose, () => expect(target).toContain(substring));
}
