import * as path from "node:path";
import * as fs from "node:fs";
import * as yaml from "js-yaml";
import { spawn, SpawnOptions } from "node:child_process";

import { ENV_VAR_MAX_PRINT_LENGTH, TestEnv } from "../../src/env";
import { copyPackageAnonymous } from "../../src/package";
import { AppYaml, DEFAULT_APP_YAML, randomAppName } from "../../src/app/construct";
import { AppInfo } from "../../src";
import { appGetToAppInfo } from "../../src/convert";
import { truncateOutput } from "../../src/util";

// Increase timeout: deploying multiple apps can take time.
jest.setTimeout(20 * 60 * 1000);

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
        continue
      }
      if (fs.existsSync(path.join(currentPath, 'wasmer.toml')) || fs.existsSync(path.join(currentPath, 'pyproject.toml'))) {
        foundDirs.push(currentPath);
      }
      foundDirs = foundDirs.concat(findPackageDirs(currentPath));
    }
  }
  return foundDirs;
}

async function overwriteAppYaml(dir: string, namespace: string): Promise<void> {
  const appYamlPath = path.join(dir, "app.yaml");
  let app: AppYaml;
  try {
    await fs.promises.access(appYamlPath, fs.constants.F_OK);
    const raw = await fs.promises.readFile(appYamlPath, "utf-8");
    const loaded = yaml.load(raw);
    app = AppYaml.parse(loaded);
    app.domains = []
  } catch {
    // App yaml not found, create it
    app = AppYaml.parse(DEFAULT_APP_YAML)
  }

  app.owner = namespace;
  app.name = randomAppName();
  if (app.app_id) delete app.app_id;
  // Write back as YAML to preserve expected format
  const dumped = yaml.dump(app);
  await fs.promises.writeFile(appYamlPath, dumped, "utf-8");
}

async function runShellCommand(
  cmdStr: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  verbose: boolean = false
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    env: opts.env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  };

  console.info(`Running: ${cmdStr}`)
  const proc = spawn(cmdStr, spawnOpts);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const MAX_STDOUT_STDERR_LENGTH = parseInt(
    process.env[ENV_VAR_MAX_PRINT_LENGTH] || "1024",
    10,
  );

  return await new Promise((resolve, reject) => {
    proc.on("error", (err) => {
      reject(err);
    });
    proc.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    proc.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
    proc.on("close", (code) => {
      let stdout = Buffer.concat(stdoutChunks).toString("utf8");
      let stderr = Buffer.concat(stderrChunks).toString("utf8");
      const { truncatedStdout, truncatedStderr } = truncateOutput(
        stdout,
        stderr,
        MAX_STDOUT_STDERR_LENGTH,
      );
      if (!verbose) {
        stdout = truncatedStdout
        stderr = truncatedStderr
      }
      if (code !== 0) {
        const err = new Error(
          `Command failed with exit code ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
        );
        reject(err);
      } else {
        resolve({ stdout, stderr, code });
      }
    });
  });
}

async function tryShipitDeploy(workDir: string, env: TestEnv) {
  const cmd = `uvx --refresh shipit-cli==0.5.1 --wasmer-deploy --wasmer-registry=${env.registry} --wasmer-app-owner=${env.namespace} --skip-prepare`;
  const procEnv = { ...process.env };
  procEnv.WASMER_REGISTRY = env.registry;
  procEnv.WASMER_TOKEN = env.token ?? procEnv.WASMER_TOKEN;
  procEnv.WASMER_NAMESPACE = env.namespace;

  // We get output here but we can't parse it to some app info 
  // since the output isn't even close to being anything json
  // and I don't want to need to rely on it being so
  const { stdout, stderr } = await runShellCommand(cmd, {
    cwd: workDir,
    env: procEnv,
  },
    env.verbose
  );

  console.info("Shipit deploy stdout on newline:\n", stdout)
  console.info("Shipit deploy stderr on newline:\n", stderr)

  if (!fs.existsSync(path.join(workDir, ".shipit", "wasmer"))) {
    throw new Error("cant find app version since .shipit/wasmer doesnt exist");
  }
  // The app may be successfully deployed here, but shipit output differes from wasmer outpu
  // Try to resolve this by getting the app data from the deployed shipit directory
  // and convert to AppInfo
  return appGetToAppInfo(await env.getAppGetFromDir(path.join(workDir, ".shipit", "wasmer")));
}

describe("wasmopticon: Crawl and deploy", () => {
  const env = TestEnv.fromEnv();
  const packageDirs = findPackageDirs("./wasmopticon");
  expect(packageDirs.length).toBeGreaterThan(0);

  test.concurrent.each(packageDirs)("deploy %s", async (pkgDir) => {
    const workDir = await copyPackageAnonymous(pkgDir);
    await overwriteAppYaml(workDir, env.namespace);
    let app: AppInfo;
    try {
      app = await tryShipitDeploy(workDir, env);
    } catch (err) {
      console.error("failed to deploy via shipit", err);
      console.info("failling back to normal deploy");
      app = await env.deployAppDir(workDir);
    }
    await env.deleteApp(app);
  });
});
