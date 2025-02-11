import path from "node:path";
import process from "node:process";
import fs from "node:fs";

import { exists } from "jsr:@std/fs";

import { sleep } from "./util.ts";

import { ENV_VAR_WASMOPTICON_DIR } from "./env.ts";

// Path to the wasmopticon repo.
export async function wasmopticonDir(): Promise<string> {
  const WASMOPTICON_GIT_URL = "https://github.com/wasix-org/wasmopticon.git";
  const dir = process.env[ENV_VAR_WASMOPTICON_DIR];
  if (dir) {
    const doesExist = await exists(dir);
    if (!doesExist) {
      throw new Error(
        `${ENV_VAR_WASMOPTICON_DIR} is set, but directory does not exist: ${dir}`,
      );
    }
    return dir;
  }

  // No env var set, check the default location.
  const localDir = path.join(process.cwd(), "wasmopticon");

  // Acquire a lock to prevent multiple concurrent clones.
  const lockPath = path.join(process.cwd(), "wasmopticon-clone.lock");
  while (true) {
    try {
      fs.promises.writeFile(lockPath, "", { flag: "wx" });
      // Lock acquired, start cloning.
      break;
    } catch {
      // Lock already exists.
      // Wait a bit and try again.
      await sleep(1000);
    }
  }

  const freeLock = async () => {
    await fs.promises.unlink(lockPath);
  };

  // Lock acquired.
  if (await exists(localDir)) {
    await freeLock();
    return localDir;
  }

  console.log("wasmopticon dir not found");
  console.log(`Cloning ${WASMOPTICON_GIT_URL} to ${localDir}...`);

  const cmd = new Deno.Command("git", {
    args: ["clone", WASMOPTICON_GIT_URL, localDir],
  });
  const output = await cmd.output();
  await freeLock();
  if (!output.success) {
    throw new Error(`Failed to clone wasmopticon: ${output.code}`);
  }
  return localDir;
}
