import { findPackageDirs } from "../../src/fs";
import { AppInfo, TestEnv } from "../../src/index";
import { copyPackageAnonymous } from "../../src/package";

test.concurrent("async python timing out", async () => {
  const env = TestEnv.fromEnv();
  const pkgDirs = findPackageDirs("./fixtures/python/")
  if (pkgDirs.length !== 1) {
    throw new Error(`expected only to find the toolbox packagedir, found: ${pkgDirs}`)
  }
  let toolboxDir = pkgDirs[0];
  const workDir = await copyPackageAnonymous(toolboxDir);
  let app: AppInfo;
  app = await env.deployAppDir(workDir, {
    extraCliArgs: ["--build-remote"],
  });
  await env.deleteApp(app);
})
