import { TestEnv } from "../../src/env";

test("ssh", async () => {
  const env = TestEnv.fromEnv();

  const runSsh = async (args: string[], stdin?: string) => {
    const output = await env.runWasmerCommand({
      args: ["ssh", ...args],
      stdin,
    });
    const stdout = output.stdout.replace("\r\n", "\n").trim();
    return stdout;
  };

  {
    const res = await runSsh(["wasmer/bash", "--", "-c", "pwd"]);
    expect(res).toBe("/");
  }

  {
    const res = await runSsh(["--", "bash", "-c", "'echo hello'"]);
    expect(res).toBe("hello");
  }

  {
    const res = await runSsh([], "pwd\n");
    expect(res).toBe("/");
  }

  {
    const res = await runSsh(["wasmer/bash", "--", "-c", "ls"]);
    const lines = res
      .trim()
      .split("\n")
      .map((line) => line.trim());
    expect(lines).toContain("bin");
    expect(lines).toContain("dev");
    expect(lines).toContain("etc");
    expect(lines).toContain("tmp");
  }

  {
    const res = await runSsh([], "echo -n hello > test && cat test\n");
    expect(res).toBe("hello");
  }
});
