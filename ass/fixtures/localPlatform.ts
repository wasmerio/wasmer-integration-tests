// Driver for the disposable local platform (QA-635): component pins via
// local.env, local-only perturbations (compose CPU caps, cache wipes), stack
// lifecycle through local-platform/cli.py, and run-dir readers. Every file it
// mutates is backed up first and restored by restoreFiles(); a stale backup
// from a crashed run is a loud error, never silently clobbered.

import {
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

export class DriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverError";
  }
}

export type ExecFn = (
  argv: string[],
  opts: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    /** Receives the child's output a line at a time so the presenter can
     * render it in ass's own voice instead of it escaping to the terminal. */
    onLine?: (line: string) => void;
  },
) => Promise<number>;

const defaultExec: ExecFn = (argv, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Piping also makes the local-platform logger drop its own colours and
    // inline progress: it checks isatty, which is now false.
    const pump = (stream: NodeJS.ReadableStream | null): void => {
      let buffer = "";
      stream?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          opts.onLine?.(line);
        }
      });
      stream?.on("end", () => {
        if (buffer.length > 0) {
          opts.onLine?.(buffer);
        }
      });
    };
    pump(child.stdout);
    pump(child.stderr);
    child.on("error", (err) =>
      reject(
        new DriverError(`failed to spawn ${argv.join(" ")}: ${err.message}`),
      ),
    );
    child.on("exit", (code, signal) =>
      resolve(code ?? (signal ? 128 : 1)),
    );
  });

const BACKUP_SUFFIX = ".ass-bak";
const ABSENT_MARKER = ".ass-absent";

/** Cache names must be plain directory names under the service cache dir. */
function validateCacheName(service: string, name: string): void {
  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".."
  ) {
    throw new DriverError(
      `perturbations.${service}.wipe_caches: "${name}" is not a plain ` +
        "cache directory name",
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Minimal reader for the generated env files (`export NAME='value'` lines,
 * shlex-quoted by write_env_file). Not a general shell parser. */
export function parseGeneratedEnvFile(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  const line = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
  for (const text of raw.split("\n")) {
    const match = line.exec(text.trim());
    if (!match) {
      continue;
    }
    let value = match[2];
    if (value.startsWith("'")) {
      // shlex.quote output: '…' with embedded quotes as '\'' or '"'"'.
      value = value
        .replace(/'\\''/g, "\u0000")
        .replace(/'"'"'/g, "\u0000")
        .replace(/^'|'$/g, "")
        .replaceAll("\u0000", "'");
    } else if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export interface DriverIo {
  info(line: string): void;
}

/** What the state manager needs from a platform driver; the real
 * implementation is LocalPlatformDriver, tests substitute fakes. */
export interface PlatformDriver {
  /** Repository root; where run artifacts live when no stack is booted. */
  readonly repoDir: string;
  applyPins(pins: Record<string, string>): void;
  applyCpus(service: string, cpus: number): void;
  wipeCaches(service: string, names: string[]): void;
  restoreFiles(): string[];
  up(extraEnv?: Record<string, string>): Promise<void>;
  down(): Promise<string | null>;
  currentRunDir(): string | null;
  readTestEnv(): Record<string, string>;
  readResolvedEnv(): Record<string, string>;
  composeFollowLogPath(): string;
  edgePlatformConfigPath(): string;
}

export class LocalPlatformDriver implements PlatformDriver {
  readonly repoDir: string;
  private readonly exec: ExecFn;
  private readonly io: DriverIo;
  /** Files mutated this run, in mutation order. */
  private mutated: string[] = [];

  private readonly dockerWipe?: (dir: string) => void;
  private readonly onLine?: (line: string) => void;

  constructor(
    repoDir: string,
    options: {
      exec?: ExecFn;
      io?: DriverIo;
      /** Test seam for the container-based cache wipe fallback. */
      dockerWipe?: (dir: string) => void;
      /** Sink for the child CLI's output; the presenter renders it. */
      onLine?: (line: string) => void;
    } = {},
  ) {
    this.repoDir = repoDir;
    this.exec = options.exec ?? defaultExec;
    this.dockerWipe = options.dockerWipe;
    this.onLine = options.onLine;
    this.io = options.io ?? { info: (line) => process.stderr.write(`${line}\n`) };
  }

  get localEnvPath(): string {
    return path.join(this.repoDir, "local.env");
  }

  get composePath(): string {
    return path.join(this.repoDir, "docker-compose.local-platform.yaml");
  }

  private cacheDir(service: string): string {
    return path.join(this.repoDir, ".local-platform", "cache", service);
  }

  // -- backed-up file mutations ---------------------------------------------

  private backup(file: string): void {
    if (this.mutated.includes(file)) {
      return; // already backed up this run
    }
    const bak = file + BACKUP_SUFFIX;
    const absent = file + ABSENT_MARKER;
    if (existsSync(bak) || existsSync(absent)) {
      throw new DriverError(
        `stale backup ${existsSync(bak) ? bak : absent} exists — a previous ` +
          "ass run did not restore it. Inspect and restore/remove it " +
          "manually before running again.",
      );
    }
    if (existsSync(file)) {
      copyFileSync(file, bak);
    } else {
      writeFileSync(absent, "");
    }
    this.mutated.push(file);
  }

  /** Restore every mutated file to its pre-run state. Never throws; returns
   * error strings so an original failure is not masked (error-coverage row
   * "cleanup itself fails"). */
  restoreFiles(): string[] {
    const errors: string[] = [];
    for (const file of [...this.mutated].reverse()) {
      const bak = file + BACKUP_SUFFIX;
      const absent = file + ABSENT_MARKER;
      try {
        if (existsSync(bak)) {
          renameSync(bak, file);
        } else if (existsSync(absent)) {
          unlinkSync(absent);
          rmSync(file, { force: true });
        } else {
          errors.push(`backup for ${file} disappeared; file left as-is`);
        }
      } catch (err) {
        errors.push(`could not restore ${file}: ${String(err)}`);
      }
    }
    this.mutated = this.mutated.filter((file) => {
      const restored =
        !existsSync(file + BACKUP_SUFFIX) && !existsSync(file + ABSENT_MARKER);
      return !restored;
    });
    return errors;
  }

  /** Pin component versions by appending to local.env: appended values win
   * over earlier lines (sequential-source semantics), and local.env itself
   * wins over ambient env inside the local-platform tooling. */
  applyPins(pins: Record<string, string>): void {
    this.backup(this.localEnvPath);
    const original = existsSync(this.localEnvPath)
      ? readFileSync(this.localEnvPath, "utf8")
      : "";
    const lines = Object.entries(pins).map(
      ([name, value]) => `export ${name}=${shellQuote(value)}`,
    );
    writeFileSync(
      this.localEnvPath,
      `${original.replace(/\n?$/, "\n")}# --- ass pins (restored after the run) ---\n${lines.join("\n")}\n`,
    );
  }

  /** Cap a compose service's CPUs by inserting `cpus:` under its service key
   * (the WAX-600 trigger; local-only by construction). */
  applyCpus(service: string, cpus: number): void {
    this.backup(this.composePath);
    const raw = readFileSync(this.composePath, "utf8");
    const serviceLine = `  ${service}:`;
    const lines = raw.split("\n");
    const index = lines.findIndex((line) => line === serviceLine);
    if (index === -1) {
      throw new DriverError(
        `cannot apply cpus perturbation: compose file has no service ` +
          `"${service}" (${this.composePath})`,
      );
    }
    lines.splice(index + 1, 0, `    cpus: ${cpus}`);
    writeFileSync(this.composePath, lines.join("\n"));
  }

  /** Wipe named cache directories under .local-platform/cache/<service>/ so
   * instances cold-start like CI. The wipe IS the declared perturbation; the
   * caches self-heal on the next boot. Cache entries written by the edge
   * container are root-owned under rootful Docker, so a plain unlink can hit
   * EACCES — fall back to wiping through a container on the same engine. */
  wipeCaches(service: string, names: string[]): void {
    for (const name of names) {
      validateCacheName(service, name);
      const target = path.join(this.cacheDir(service), name);
      if (!existsSync(target)) {
        continue;
      }
      try {
        rmSync(target, { recursive: true, force: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EACCES" && code !== "EPERM") {
          throw new DriverError(`cannot wipe cache ${target}: ${String(err)}`);
        }
        this.containerWipe(target);
        rmSync(target, { recursive: true, force: true });
      }
      this.io.info(`wiped cache ${path.relative(this.repoDir, target)}`);
    }
  }

  private containerWipe(target: string): void {
    this.io.info(
      `cache ${path.relative(this.repoDir, target)} has container-owned ` +
        "entries; wiping via docker",
    );
    const wipe =
      this.dockerWipe ??
      ((dir: string): void => {
        const result = spawnSync(
          "docker",
          [
            "run",
            "--rm",
            "-v",
            `${dir}:/ass-wipe`,
            "busybox:stable",
            "sh",
            "-c",
            "find /ass-wipe -mindepth 1 -delete",
          ],
          { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
        );
        if (result.status !== 0) {
          throw new DriverError(
            `docker-based cache wipe of ${dir} failed ` +
              `(status ${result.status}): ${result.stderr?.trim() || result.error?.message || "unknown error"}`,
          );
        }
      });
    wipe(target);
  }

  // -- stack lifecycle ------------------------------------------------------

  private cliArgv(command: string): string[] {
    return [
      "python3",
      path.join(this.repoDir, "local-platform", "cli.py"),
      command,
    ];
  }

  async up(extraEnv: Record<string, string> = {}): Promise<void> {
    const code = await this.exec(this.cliArgv("up"), {
      cwd: this.repoDir,
      onLine: this.onLine,
      env: {
        ...process.env,
        // The run must stay up between fixture resolution and workload; the
        // ass cleanup handle owns teardown.
        LOCAL_PLATFORM_AUTO_DOWN: "0",
        ...extraEnv,
      },
    });
    if (code !== 0) {
      throw new DriverError(`local platform up failed with status ${code}`);
    }
  }

  /** Best-effort teardown; returns an error string instead of throwing. */
  async down(): Promise<string | null> {
    if (this.currentRunDir() === null) {
      return null;
    }
    try {
      const code = await this.exec(this.cliArgv("down"), {
        cwd: this.repoDir,
        env: { ...process.env },
        onLine: this.onLine,
      });
      return code === 0
        ? null
        : `local platform down failed with status ${code}`;
    } catch (err) {
      return `local platform down failed: ${String(err)}`;
    }
  }

  // -- run-dir readers ------------------------------------------------------

  currentRunDir(): string | null {
    const current = path.join(this.repoDir, ".local-platform", "current");
    try {
      return realpathSync(current);
    } catch {
      return null;
    }
  }

  private requireRunDir(): string {
    const dir = this.currentRunDir();
    if (dir === null) {
      throw new DriverError(
        "no current local platform run (.local-platform/current missing)",
      );
    }
    return dir;
  }

  private readEnvFile(name: string, required: boolean): Record<string, string> {
    const file = path.join(this.requireRunDir(), name);
    if (!existsSync(file)) {
      if (required) {
        throw new DriverError(`missing generated env file: ${file}`);
      }
      return {};
    }
    return parseGeneratedEnvFile(readFileSync(file, "utf8"));
  }

  readTestEnv(): Record<string, string> {
    return this.readEnvFile("test-env.sh", true);
  }

  readResolvedEnv(): Record<string, string> {
    return this.readEnvFile("resolved.env", false);
  }

  composeFollowLogPath(): string {
    return path.join(this.requireRunDir(), "logs", "compose.follow.log");
  }

  edgePlatformConfigPath(): string {
    return path.join(this.requireRunDir(), "edge", "platform_config.yaml");
  }
}
