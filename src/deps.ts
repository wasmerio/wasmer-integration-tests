import * as path from "path";
import * as process from "process";
import * as fs from "fs";

import { sleep } from "./util";

import { ENV_VAR_WASMOPTICON_DIR } from "./env";
import { spawn } from "child_process";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

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

  const localDir = path.join(process.cwd(), "wasmopticon");

  const lockPath = path.join(process.cwd(), "wasmopticon-clone.lock");
  while (true) {
    try {
      fs.promises.writeFile(lockPath, "", { flag: "wx" });
      break;
    } catch {
      await sleep(1000);
    }
  }

  const freeLock = async () => {
    await fs.promises.unlink(lockPath);
  };

  if (await exists(localDir)) {
    await freeLock();
    return localDir;
  }

  console.log("wasmopticon dir not found");
  console.log(`Cloning ${WASMOPTICON_GIT_URL} to ${localDir}...`);

  await new Promise<void>((resolve, reject) => {
    const cmd = spawn("git", ["clone", WASMOPTICON_GIT_URL, localDir]);
    cmd.on("exit", (code: number) => {
      if (code !== 0) {
        reject(new Error(`Failed to clone wasmopticon: ${code}`));
      } else {
        resolve();
      }
    });
  });

  await freeLock();
  return localDir;
}
