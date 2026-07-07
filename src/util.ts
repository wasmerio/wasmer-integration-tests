export async function sleep(milliseconds: number) {
  return await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface PollUntilOptions {
  // Total time budget before giving up.
  timeoutMs: number;
  // Delay between attempts. Defaults to 3000ms.
  intervalMs?: number;
  // Human-readable description of the awaited condition, used in the
  // timeout error message.
  description?: string;
}

/**
 * Repeatedly invoke `check` until it produces a value that is neither
 * `undefined`, `null` nor `false`, and return that value.
 *
 * A `check` that throws is treated the same as one that returns `undefined`:
 * the attempt failed and will be retried. When the time budget runs out, the
 * last error (if any) is attached as the cause of the timeout error.
 */
export async function pollUntil<T>(
  check: () => Promise<T | undefined | null | false>,
  options: PollUntilOptions,
): Promise<T> {
  const intervalMs = options.intervalMs ?? 3000;
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown;

  while (true) {
    try {
      const value = await check();
      if (value !== undefined && value !== null && value !== false) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const description = options.description ?? "condition";
      const suffix =
        lastError !== undefined
          ? ` Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
          : "";
      throw new Error(
        `Timed out after ${options.timeoutMs}ms waiting for ${description}.${suffix}`,
        lastError !== undefined ? { cause: lastError } : undefined,
      );
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}

export function truncateOutput(
  stdout: string,
  stderr: string,
  maxLength: number,
): { truncatedStdout: string; truncatedStderr: string } {
  const truncate = (output: string) => {
    if (output.length > maxLength) {
      return (
        output.substring(0, maxLength - 3) +
        " ... " +
        (output.length - maxLength) +
        " more characters. Set VERBOSE=1 to see all output\n"
      );
    }
    return output;
  };

  return {
    truncatedStdout: truncate(stdout),
    truncatedStderr: truncate(stderr),
  };
}
