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
      console.log("writing file", { path, value, subPath });
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
