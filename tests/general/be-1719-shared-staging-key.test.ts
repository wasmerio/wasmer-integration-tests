import { TestEnv, buildPhpApp } from "../../src/index";
import { AppInfo } from "../../src/backend";

// Repro for BE-1719 — `wasmer deploy` fails hard on an R2 429 during package
// upload:
// https://linear.app/wasmer/issue/BE-1719/wasmer-deploy-fails-hard-on-r2-429-during-package-upload
//
// The CLI uploads a package to a content-addressed staging key,
// `tmp/<sha256-of-the-package>` in the backend's persistent bucket. The app
// name lives in `app.yaml` and is not part of that hash, so two deploys of
// the same package content — the same fixture from two tests, the same
// template from two CI shards — write to one key. R2 throttles sustained
// writes to a single key and the CLI aborts on the first 429 with no retry:
//
//   error: HTTP status client error (429 Too Many Requests) for url
//   (https://<account>.r2.cloudflarestorage.com/b-dev-eu-west-3-backend-persistent/tmp/<sha256>?…)
//
// The product promise asserted here is that deploying the same package from
// several places at once works. Every other test in the suite now salts its
// package (`writeAppDefinition` adds a random file to the packaged
// filesystem), so this file is the only place the collision is still
// provoked, via `uniquePackage: false`.
//
// Expected red until BE-1719 ships. Please do not skip, quarantine, or invert
// it — coordinate on the ticket instead.

const CONCURRENT_DEPLOYS = 6;

test("be-1719-concurrent-deploys-of-identical-packages", async () => {
  const env = TestEnv.fromEnv();

  // One fixture, deployed several times over: identical bytes, therefore one
  // shared staging key.
  const code = '<?php echo "be-1719";';
  const specs = Array.from({ length: CONCURRENT_DEPLOYS }, () =>
    buildPhpApp(code),
  );

  const results = await Promise.allSettled(
    specs.map((spec) => env.deployApp(spec, { uniquePackage: false })),
  );

  const deployed = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );

  try {
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [String(result.reason)] : [],
    );
    expect(failures).toEqual([]);
    expect(deployed).toHaveLength(CONCURRENT_DEPLOYS);
  } finally {
    await Promise.all(deployed.map((info: AppInfo) => env.deleteApp(info)));
  }
}, 300_000);
