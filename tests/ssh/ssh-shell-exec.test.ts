import { EventEmitter } from "node:events";

import type { Client } from "ssh2";

import { sshShellExec } from "../../src/ssh";

interface FakeShellOptions {
  // Where the PTY echo of typed input (and prompt) is emitted. The app-ssh
  // shell echoes on stdout; the WordPress bash-dist shell echoes on stderr.
  echoChannel?: "stdout" | "stderr";
  prompt?: string;
}

// Fake interactive shell that echoes typed input back (PTY echo), like the
// updated ssh backend. Emits command output and the END:$RC marker lines.
class FakeShellStream extends EventEmitter {
  stderr = new EventEmitter();
  private rc: number;
  private cmdOutput: string;
  private echoChannel: "stdout" | "stderr";
  private prompt: string;
  private pending = "";
  private ended = false;

  constructor(rc: number, cmdOutput: string, options: FakeShellOptions = {}) {
    super();
    this.rc = rc;
    this.cmdOutput = cmdOutput;
    this.echoChannel = options.echoChannel ?? "stdout";
    this.prompt = options.prompt ?? "";
  }

  write(data: string): void {
    this.pending += data;
    let idx: number;
    while ((idx = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, idx);
      this.pending = this.pending.slice(idx + 1);
      // PTY echo of the typed line, in a separate tick like a real socket
      setImmediate(() => {
        this.echoInput(line);
        this.execute(line);
      });
    }
  }

  private echoInput(line: string): void {
    const data = Buffer.from(`${this.prompt}${line}\r\n`);
    if (this.echoChannel === "stderr") {
      this.stderr.emit("data", data);
    } else {
      this.emit("data", data);
    }
  }

  private execute(line: string): void {
    if (line.startsWith("echo __START_")) {
      this.emit("data", Buffer.from(`${line.slice("echo ".length)}\r\n`));
    } else if (/^echo __END_.*\$RC 1>&2$/.test(line)) {
      const marker = line.slice("echo ".length).replace(" 1>&2", "");
      this.stderr.emit(
        "data",
        Buffer.from(`${marker.replace("$RC", String(this.rc))}\r\n`),
      );
    } else if (/^echo __END_.*\$RC$/.test(line)) {
      const marker = line.slice("echo ".length);
      this.emit(
        "data",
        Buffer.from(`${marker.replace("$RC", String(this.rc))}\r\n`),
      );
    } else if (line !== "RC=$?") {
      // the command under test
      if (this.cmdOutput) {
        this.emit("data", Buffer.from(this.cmdOutput));
      }
    }
  }

  end(): void {
    if (!this.ended) {
      this.ended = true;
      setImmediate(() => this.emit("close"));
    }
  }

  removeListener(event: string, fn: (...args: unknown[]) => void): this {
    super.removeListener(event, fn);
    return this;
  }
}

function fakeConn(stream: FakeShellStream): Client {
  return {
    shell: (cb: (err: Error | undefined, stream: FakeShellStream) => void) => {
      setImmediate(() => cb(undefined, stream));
    },
  } as unknown as Client;
}

test("parses real exit code 0 despite PTY echo of marker commands", async () => {
  const stream = new FakeShellStream(0, "hello-output\r\n");
  const result = await sshShellExec(fakeConn(stream), "echo hello-output");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("hello-output");
  expect(result.stdout).not.toMatch(/__END_|__START_|RC=\$\?/);
});

test("parses non-zero multi-digit exit code, not digits inside marker", async () => {
  const stream = new FakeShellStream(127, "oops-out\r\n");
  const result = await sshShellExec(fakeConn(stream), "some-missing-cmd", true);
  expect(result.code).toBe(127);
});

test("stderr marker lines are stripped", async () => {
  const stream = new FakeShellStream(1, "");
  const result = await sshShellExec(fakeConn(stream), "false", true);
  expect(result.code).toBe(1);
  expect(result.stderr).not.toContain("__END_");
});

test("keeps output that has no trailing newline (shares line with END marker)", async () => {
  // `wp eval 'echo json_encode(...)'` prints JSON without a trailing newline,
  // so stdout contains `{"status":"ok"}__END_x__:0` on a single line.
  const stream = new FakeShellStream(0, '{"status":"ok"}', {
    echoChannel: "stderr",
    prompt: "bash-dist# ",
  });
  const result = await sshShellExec(
    fakeConn(stream),
    `cd '/' && wp eval 'echo json_encode(["status" => "ok"]);'`,
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ status: "ok" });
});

test("prompt-prefixed echo on stderr does not pollute stdout or code", async () => {
  const stream = new FakeShellStream(3, "some output\r\n", {
    echoChannel: "stderr",
    prompt: "bash-dist# ",
  });
  const result = await sshShellExec(fakeConn(stream), "wp broken", true);
  expect(result.code).toBe(3);
  expect(result.stdout.trim()).toBe("some output");
  expect(result.stderr).not.toContain("__END_");
});
