// One spawn-and-capture boundary for every executor (QA-637). Jest,
// raw-wasmer, artillery-http and host-process differ only in the argv they
// build: capture, timeout backstop, log-file naming and the RunOutcome shape
// are shared here so a new executor cannot invent its own.

import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import type { RunOutcome, WorkloadExec, WorkloadResult } from "./contract";

export const defaultWorkloadExec: WorkloadExec = (argv, opts) =>
  new Promise<WorkloadResult>((resolve, reject) => {
    const stdout = createWriteStream(opts.stdoutFile);
    const stderr = createWriteStream(opts.stderrFile);
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // The full stream is always captured to disk; what reaches the terminal
    // goes through the presenter so the workload speaks in ASS's voice.
    const mirror = (file: NodeJS.WritableStream): ((chunk: Buffer) => void) => {
      let buffer = "";
      return (chunk: Buffer) => {
        file.write(chunk);
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          opts.onLine?.(line);
        }
      };
    };
    child.stdout.on("data", mirror(stdout));
    child.stderr.on("data", mirror(stderr));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutSeconds * 1000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(`failed to spawn workload ${argv.join(" ")}: ${err.message}`),
      );
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      stdout.end();
      stderr.end();
      resolve({ exitCode: code ?? (signal ? 128 : 1), timedOut, signal });
    });
  });

export interface CapturedRunOptions {
  argv: string[];
  cwd: string;
  /** Merged over `process.env`; the resolved test env goes here. */
  env: Record<string, string>;
  timeoutSeconds: number;
  artifactsDir: string;
  /** Log-file prefix: `<label>.stdout.log` / `<label>.stderr.log`. A run may
   * capture several processes (workload, baseline, controls), so they cannot
   * share one name. */
  label: string;
  exec?: WorkloadExec;
  onLine?: (line: string) => void;
  counters?: Record<string, number>;
}

/** Run one process and shape its result as the common RunOutcome. */
export async function runCaptured(
  options: CapturedRunOptions,
): Promise<RunOutcome> {
  const exec = options.exec ?? defaultWorkloadExec;
  mkdirSync(options.artifactsDir, { recursive: true });
  const stdoutFile = path.join(
    options.artifactsDir,
    `${options.label}.stdout.log`,
  );
  const stderrFile = path.join(
    options.artifactsDir,
    `${options.label}.stderr.log`,
  );

  const startedAt = new Date().toISOString();
  const result = await exec(options.argv, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      FORCE_COLOR: "0", // captured logs feed the verdict engine; no ANSI
    },
    stdoutFile,
    stderrFile,
    timeoutSeconds: options.timeoutSeconds,
    onLine: options.onLine,
  });
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    counters: options.counters ?? {},
    logs: { stdout: stdoutFile, stderr: stderrFile },
    exitCode: result.exitCode,
    signal: result.signal ?? null,
    timedOut: result.timedOut,
    command: options.argv,
  };
}
