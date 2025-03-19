import fs from "node:fs";
import path from "node:path";
import * as toml from "jsr:@std/toml";

import { createTempDir, Path } from "./fs.ts";

/// Copy a package directory to a new location and remove package name/version
/// from wasmer.toml.
///
/// If dest is not specified, the package will be copied to a temporary directory.
/// The destination directory will be returned.
export async function copyPackageAnonymous(
  src: Path,
  dest?: Path,
): Promise<Path> {
  if (!dest) {
    dest = await createTempDir();
  }
  await fs.promises.cp(src, dest);
  const sourcename = path.basename(src);
  dest = path.join(dest, sourcename);

  const wasmerTomlPath = path.join(dest, "wasmer.toml");
  const tomlContents = await fs.promises.readFile(wasmerTomlPath, "utf-8");
  const manifest = toml.parse(tomlContents);
  delete manifest["package"];
  const newTomlContents = toml.stringify(manifest);
  await fs.promises.writeFile(wasmerTomlPath, newTomlContents);

  return dest;
}
