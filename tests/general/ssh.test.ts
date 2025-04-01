import { assertEquals } from "jsr:@std/assert/equals";
import { TestEnv } from "../../src/env.ts";
import { assertArrayIncludes } from "jsr:@std/assert/array-includes";

Deno.test("ssh", async () => {
  const env = TestEnv.fromEnv();

  const runSsh = async (args: string[], stdin?: string) => {
    const output = await env.runWasmerCommand({
      args: ["ssh", ...args],
      stdin,
      noAssertSuccess: true,
    });
    const stdout = output.stdout.replace("\r\n", "\n").trim();
    return stdout;
  };

  {
    const res = await runSsh(["wasmer/bash", "--", "-c", "pwd"]);
    assertEquals(res, "/");
  }

  {
    const res = await runSsh([], "pwd\n");
    assertEquals(res, "/");
  }

  {
    const res = await runSsh(["wasmer/bash", "--", "-c", "ls"]);
    const lines = res.trim().split("\n").map((line) => line.trim());
    assertArrayIncludes(lines, ["bin"]);
    assertArrayIncludes(lines, ["dev"]);
    assertArrayIncludes(lines, ["etc"]);
    assertArrayIncludes(lines, ["tmp"]);
  }

  {
    const res = await runSsh([], "echo -n hello > test && cat test\n");
    assertEquals(res, "hello");
  }
});
