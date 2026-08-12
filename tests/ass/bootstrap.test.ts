// `make ass` bootstrap tests (Phase 3). The detector is POSIX sh because it
// runs before any toolchain exists, so it is tested the way it is used: as a
// process, with a fake HOME for harness state and a fake PATH for the harness
// commands themselves. Nothing here touches the developer's machine.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DETECTOR = path.join(
  __dirname,
  "..",
  "..",
  "ass",
  "bootstrap",
  "detect.sh",
);
const HARNESSES = ".hivemind:hv-agent .otheragent:other-agent";

const trees: string[] = [];
afterAll(() => {
  for (const tree of trees) {
    rmSync(tree, { recursive: true, force: true });
  }
});

interface Sandbox {
  home: string;
  bin: string;
  /** Where a launched fake harness records the arguments it received. */
  receipt: string;
}

function sandbox(): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "ass-bootstrap-"));
  trees.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  return { home, bin, receipt: path.join(root, "receipt") };
}

function harnessState(box: Sandbox, name: string, mtime?: number): void {
  const dir = path.join(box.home, name);
  mkdirSync(dir, { recursive: true });
  if (mtime !== undefined) {
    utimesSync(dir, mtime, mtime);
  }
}

function fakeCommand(box: Sandbox, name: string, body: string): void {
  const file = path.join(box.bin, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

function detect(box: Sandbox, env: Record<string, string> = {}) {
  const result = spawnSync("sh", [DETECTOR], {
    encoding: "utf8",
    env: {
      HOME: box.home,
      PATH: `${box.bin}:/usr/bin:/bin`,
      ASS_BOOTSTRAP_HARNESSES: HARNESSES,
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout + result.stderr };
}

describe("make ass harness detection", () => {
  test("reports the detected harness and the exact launch command", () => {
    const box = sandbox();
    harnessState(box, ".hivemind");
    fakeCommand(box, "hv-agent", "exit 0");
    const result = detect(box, { ASS_BOOTSTRAP_DRY_RUN: "1" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("harness:  hv-agent");
    expect(result.stdout).toContain('hv-agent "Follow ass/bootstrap/SETUP.md');
    expect(result.stdout).toContain("pnpm ass doctor");
    // Detect only: it says what it found, it does not act on it.
    expect(result.stdout).toContain("installs nothing itself");
  });

  test("the most recently used harness wins", () => {
    const box = sandbox();
    const now = Date.now() / 1000;
    harnessState(box, ".otheragent", now - 86_400);
    harnessState(box, ".hivemind", now);
    fakeCommand(box, "hv-agent", "exit 0");
    fakeCommand(box, "other-agent", "exit 0");
    expect(detect(box, { ASS_BOOTSTRAP_DRY_RUN: "1" }).stdout).toContain(
      "harness:  hv-agent",
    );

    const older = sandbox();
    harnessState(older, ".otheragent", now);
    harnessState(older, ".hivemind", now - 86_400);
    fakeCommand(older, "hv-agent", "exit 0");
    fakeCommand(older, "other-agent", "exit 0");
    expect(detect(older, { ASS_BOOTSTRAP_DRY_RUN: "1" }).stdout).toContain(
      "harness:  other-agent",
    );
  });

  test("state without the command falls through to the next harness", () => {
    const box = sandbox();
    const now = Date.now() / 1000;
    harnessState(box, ".hivemind", now); // most recent, but not installed
    harnessState(box, ".otheragent", now - 86_400);
    fakeCommand(box, "other-agent", "exit 0");
    expect(detect(box, { ASS_BOOTSTRAP_DRY_RUN: "1" }).stdout).toContain(
      "harness:  other-agent",
    );
  });

  test("it actually launches the harness with the setup contract", () => {
    const box = sandbox();
    harnessState(box, ".hivemind");
    fakeCommand(box, "hv-agent", `printf '%s' "$1" > "${box.receipt}"`);
    const result = detect(box);
    expect(result.status).toBe(0);
    const prompt = readFileSync(box.receipt, "utf8");
    expect(prompt).toContain("ass/bootstrap/SETUP.md");
    expect(prompt).toContain("pnpm ass doctor");
  });

  test("a launch that cannot run prints the manual path", () => {
    const box = sandbox();
    harnessState(box, ".hivemind");
    fakeCommand(box, "hv-agent", "exit 127");
    const result = detect(box);
    expect(result.stdout).toContain("Could not launch hv-agent");
    expect(result.stdout).toContain("make setup");
    expect(result.stdout).toContain("pnpm ass doctor");
  });

  test("a session's own exit code is passed through, not misread as a failure", () => {
    const box = sandbox();
    harnessState(box, ".hivemind");
    fakeCommand(box, "hv-agent", "exit 3");
    const result = detect(box);
    expect(result.status).toBe(3);
    expect(result.stdout).not.toContain("Could not launch");
  });

  test("no harness at all prints the SETUP quick path", () => {
    const box = sandbox();
    const result = detect(box);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("harness:  none detected");
    expect(result.stdout).toContain("ass/bootstrap/SETUP.md");
    expect(result.stdout).toContain("make setup");
    expect(result.stdout).toContain("pnpm ass doctor");
  });

  test("state present but nothing installed says which command is missing", () => {
    const box = sandbox();
    harnessState(box, ".hivemind");
    const result = detect(box);
    expect(result.stdout).toContain("state found for hv-agent");
    expect(result.stdout).toContain("no such command on PATH");
  });
});

// R4-02: SETUP.md makes `ass doctor` the first thing an agent runs, so the
// entry point has to explain the un-installed machine rather than dying on a
// bare exec failure — that is the one state doctor exists to diagnose.
describe("the ass entry point before anything is installed", () => {
  const ENTRY = path.join(__dirname, "..", "..", "bin", "ass");

  test("a tree with no node_modules gets doctor's own remediation", () => {
    const box = sandbox();
    const repo = path.join(box.home, "repo");
    mkdirSync(path.join(repo, "bin"), { recursive: true });
    const copy = path.join(repo, "bin", "ass");
    writeFileSync(copy, readFileSync(ENTRY, "utf8"));
    chmodSync(copy, 0o755);

    const result = spawnSync(copy, ["doctor"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain("dependencies are not installed");
    expect(output).toContain("make setup");
    expect(output).not.toContain("not found"); // not a bare exec failure
  });

  test("with the runner present it execs it with the arguments untouched", () => {
    const box = sandbox();
    const repo = path.join(box.home, "repo");
    mkdirSync(path.join(repo, "bin"), { recursive: true });
    mkdirSync(path.join(repo, "node_modules", ".bin"), { recursive: true });
    const copy = path.join(repo, "bin", "ass");
    writeFileSync(copy, readFileSync(ENTRY, "utf8"));
    chmodSync(copy, 0o755);
    const runner = path.join(repo, "node_modules", ".bin", "tsx");
    writeFileSync(runner, `#!/bin/sh\nprintf '%s\\n' "$@" > ${box.receipt}\n`);
    chmodSync(runner, 0o755);

    expect(spawnSync(copy, ["run", "wax-600", "--cpus", "1"]).status).toBe(0);
    const received = readFileSync(box.receipt, "utf8").trim().split("\n");
    expect(received[0]).toContain(path.join("ass", "main.ts"));
    expect(received.slice(1)).toEqual(["run", "wax-600", "--cpus", "1"]);
  });
});
