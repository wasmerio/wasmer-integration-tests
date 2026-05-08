import { TestEnvironment as NodeEnvironment } from "jest-environment-node";

const FAILED_JEST_TEST_NAMES_KEY = Symbol.for(
  "wasmer-integration-tests.failed-jest-test-names",
);

function testFullName(test) {
  const names = [];
  let current = test;
  while (current) {
    if (current.name && current.name !== "ROOT_DESCRIBE_BLOCK") {
      names.push(current.name);
    }
    current = current.parent;
  }
  return names.reverse().join(" ");
}

class PreserveFailingAppsEnvironment extends NodeEnvironment {
  markTestFailed(test) {
    if (!test) {
      return;
    }

    this.global[FAILED_JEST_TEST_NAMES_KEY] ??= new Set();
    this.global[FAILED_JEST_TEST_NAMES_KEY].add(testFullName(test));
  }

  async handleTestEvent(event) {
    if (event.name === "test_fn_failure" || event.name === "hook_failure") {
      this.markTestFailed(event.test);
    }
  }
}

export default PreserveFailingAppsEnvironment;
