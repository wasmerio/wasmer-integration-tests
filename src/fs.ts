import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

export type Path = string;

export interface DirEntry extends Record<Path, string | DirEntry> {
  [key: Path]: string | DirEntry;
}

// Build a file system directory from the provided directory tree.
export async function buildDir(path: Path, files: DirEntry): Promise<void> {
  for (const [name, value] of Object.entries(files)) {
    const subPath = `${path}/${name}`;
    if (typeof value === "string") {
      if (process.env.VERBOSE) {
        console.log("writing file", { path, value, subPath });
      } else {
        console.log(
          `File writes obfuscated, please set VERBOSE=<truthy> to see file writes`,
        );
      }
      await fs.promises.writeFile(subPath, value);
    } else {
      await fs.promises.mkdir(subPath, { recursive: true });
      await buildDir(subPath, value);
    }
  }
}

export async function createTempDir(): Promise<Path> {
  const dir = path.join(os.tmpdir(), crypto.randomUUID());
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

// Build a temporary directory from the provided directory tree.
export async function buildTempDir(files: DirEntry): Promise<Path> {
  const tempDir = await createTempDir();
  await buildDir(tempDir, files);
  return tempDir;
}

// findPackageDirs by recursively crawling some directory root looking for indicators of a deployable project
export function findPackageDirs(root: string): string[] {
  let foundDirs: string[] = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });

  for (const entry of entries) {
    const currentPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      // Shipit creates a copy. We don't want to attempt to deploy this copy, as this will create nested deployments
      // This issue only arises while debugging/multiple subsequent runs
      if (currentPath.includes(".shipit")) {
        continue;
      }
      if (
        fs.existsSync(path.join(currentPath, "wasmer.toml")) ||
        fs.existsSync(path.join(currentPath, "pyproject.toml"))
      ) {
        foundDirs.push(currentPath);
      }
      foundDirs = foundDirs.concat(findPackageDirs(currentPath));
    }
  }
  return foundDirs;
}
