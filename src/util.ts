export async function sleep(milliseconds: number) {
  return await new Promise((resolve) => setTimeout(resolve, milliseconds));
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
