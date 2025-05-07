export function assert(isOk: boolean) {
  if (!isOk) {
    fail();
  }
}

/**
* Checks if two values are equal by comparing them using the strict equality (===) operator.
* 
* @param a - The first value to be compared.
* @param b - The second value to be compared.
* 
* This function throws an error if the values are not equal.
*/
export function assertEquals(a: any, b: any) {
  assert(a === b);
}

/**
* Checks if two values are not equal by comparing them using the strict inequality (!==) operator.
* 
* @param a - The first value to be compared.
* @param b - The second value to be compared.
* 
* This function throws an error if the values are equal.
*/
export function assertNotEquals(a: any, b: any) {
  assert(a !== b);
}

