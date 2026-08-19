// Serializes `up` per checkout (error-coverage row "two up processes
// racing"): a wx-created pidfile refuses the second process while the first
// is alive, and a lock whose owner is dead is taken over — a crashed `up`
// must never wedge the next one behind manual cleanup.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { heldStateDir } from "./descriptor";

export class HeldLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeldLockError";
  }
}

function lockPath(repoDir: string): string {
  return path.join(heldStateDir(repoDir), "up.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The live pid holding the up-lock, or null (absent lock / dead holder).
 * Lets `status` distinguish "seeding in progress" from a crashed
 * INCOMPLETE hold without anyone ps-ing pids by hand. */
export function heldLockHolder(repoDir: string): number | null {
  try {
    const holder = Number(readFileSync(lockPath(repoDir), "utf8").trim());
    if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
      return holder;
    }
  } catch {
    // Absent lock: nothing seeding.
  }
  return null;
}

export function acquireHeldLock(repoDir: string): () => void {
  const file = lockPath(repoDir);
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      return () => rmSync(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      let holder = NaN;
      try {
        holder = Number(readFileSync(file, "utf8").trim());
      } catch {
        // Racing with the holder's own release; retry the create.
      }
      if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
        throw new HeldLockError(
          `another ass up is already running (pid ${holder}, lock ${file}); ` +
            "wait for it or remove the lock if it is stale",
        );
      }
      rmSync(file, { force: true });
    }
  }
  throw new HeldLockError(
    `could not acquire ${file} — a concurrent ass up keeps recreating it`,
  );
}
