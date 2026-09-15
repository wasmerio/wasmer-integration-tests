import * as fs from "node:fs";
import * as path from "node:path";
import * as toml from "@iarna/toml";
import { type SearchPackageVersion, type StackMachine } from "stackmachine";

import { type CommandOutput, TestEnv } from "./env";
import { buildTempDir, createTempDir, Path } from "./fs";
import { pollUntil } from "./util";

export function uniquePackageName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function buildPackageVersion(
  env: TestEnv,
  name: string,
  version: string,
  content = name,
): Promise<Path> {
  return buildTempDir({
    "wasmer.toml": `
[package]
name = "${env.namespace}/${name}"
version = "${version}"

[dependencies]
"wasmer/static-web-server" = "1"

[fs]
"/public" = "public"

[[command]]
name = "script"
module = "wasmer/static-web-server:webserver"
runner = "https://webc.org/runner/wasi"
`,
    public: { "index.html": content },
  });
}

export async function publishPackageVersion(
  env: TestEnv,
  name: string,
  version: string,
  options: { content?: string; noAssertSuccess?: boolean } = {},
): Promise<CommandOutput> {
  return env.runWasmerCommand({
    args: ["publish"],
    cwd: await buildPackageVersion(env, name, version, options.content ?? name),
    noAssertSuccess: options.noAssertSuccess ?? false,
  });
}

export async function publishUniquePackage(
  env: TestEnv,
  prefix: string,
  version = "0.1.0",
): Promise<string> {
  const name = uniquePackageName(prefix);
  await publishPackageVersion(env, name, version);
  return name;
}

export async function waitForPackageSearchState(
  client: StackMachine,
  env: TestEnv,
  packageName: string,
  visible: boolean,
  timeoutMs = 120_000,
  expectedVersion?: string,
): Promise<SearchPackageVersion | null> {
  const result = await pollUntil(
    async () => {
      const page = await client.packages.search({
        query: packageName,
        filter: { owner: env.namespace },
      });
      const match = page.data.find(
        (result) =>
          result.package.namespace === env.namespace &&
          result.package.packageName === packageName &&
          (expectedVersion === undefined || result.version === expectedVersion),
      );
      if (Boolean(match) !== visible) {
        throw new Error(
          `package is ${match ? "present" : "absent"}; expected it to be ${visible ? "present" : "absent"}`,
        );
      }
      // `pollUntil` treats null as "not ready", so wrap the confirmed state.
      return { match: match ?? null };
    },
    {
      timeoutMs,
      intervalMs: 5_000,
      description: `package '${env.namespace}/${packageName}' to become ${visible ? "visible" : "hidden"} in search`,
    },
  );
  return result.match;
}

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
  await fs.promises.cp(src, dest, { recursive: true });
  const wasmerTomlPath = path.join(dest, "wasmer.toml");
  let tomlContents;
  try {
    tomlContents = await fs.promises.readFile(wasmerTomlPath, "utf-8");
  } catch (err) {
    console.error(
      "Failed to read wasmer.toml, continuing in case of shipit",
      err,
    );
    return dest;
  }
  const manifest = toml.parse(tomlContents);
  delete manifest["package"];
  const newTomlContents = toml.stringify(manifest);
  await fs.promises.writeFile(wasmerTomlPath, newTomlContents);

  return dest;
}
