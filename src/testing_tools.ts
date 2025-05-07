export function assert<T>(isOk: T, purpose?: string) {
  if (!isOk) {
    if (purpose) {
      console.error("Failure:", purpose);
    }
  }
  expect(isOk).toBe(true)
}

/**
 * Checks if two values are equal by comparing them using the strict equality (===) operator.
 *
 * @param a - The first value to be compared.
 * @param b - The second value to be compared.
 *
 * This function throws an error if the values are not equal.
 */
export function assertEquals<T>(a: T, b: T, purpose?: string) {
  assert(a === b, purpose);
}

/**
 * Checks if two values are not equal by comparing them using the strict inequality (!==) operator.
 *
 * @param a - The first value to be compared.
 * @param b - The second value to be compared.
 *
 * This function throws an error if the values are equal.
 */
export function assertNotEquals<T>(a: T, b: T, purpose?: string) {
  assert(a !== b, purpose);
}

/**
 * Verifies that all elements in the provided values array are included within the target array.
 *
 * @param array - The target array in which to search for the values.
 * @param values - The array of values that should be included in the target array.
 *
 * This function throws an error if any value from the values array is not found in the target array.
 */
export function assertArrayIncludes<T>(
  array: T[],
  values: T[],
  purpose?: string,
) {
  values.forEach((value) => {
    if (!array.includes(value)) {
      fail(`failed to find: '${value} in '${array}. Purpose: ${purpose}`);
    }
  });
}

/**
 * Verifies that the target string contains the specified substring.
 *
 * @param target - The string in which to search for the substring.
 * @param substring - The substring that should be included in the target string.
 *
 * This function throws an error if the substring is not found in the target string.
 */
export function assertStringIncludes(
  target: string,
  substring: string,
  purpose?: string,
) {
  assert(target.includes(substring), purpose);
}
