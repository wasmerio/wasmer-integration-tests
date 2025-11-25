class FailuresOnlyReporter {
  onTestResult(_testContext, testResult) {
    const hasFailures =
      testResult.numFailingTests > 0 ||
      testResult.numRuntimeErrorTestSuites > 0 ||
      testResult.testExecError != null;

    const buffer = testResult.console ?? [];

    if (hasFailures) {
      for (const entry of buffer) {
        const log = console[entry.type] ?? console.log;
        log(entry.message);
      }
    }

    testResult.console = undefined;
  }
}

export default FailuresOnlyReporter;
