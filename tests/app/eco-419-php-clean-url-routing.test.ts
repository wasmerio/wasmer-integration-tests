import { TestEnv } from "../../src";
import {
  appFetchTarget,
  deployInlinePhpApp,
  installSdkAppCleanup,
} from "../utils/stackmachine-sdk";

// Repro for ECO-419 — autobuild PHP apps 404 on clean URLs:
// https://linear.app/wasmer/issue/ECO-419/regression-autobuild-php-apps-404-on-clean-urls
//
// Native `php -S <host> -t <docroot>` routes extension-less URIs that match
// no file on disk through the docroot `index.php`, so a single-file PHP
// router app serves clean URLs like `/engine` out of the box. Builds from
// the autobuild pipeline used to preserve this by serving through the
// `php/php-32` atom; current anybuild (>= 0.25.0) forces the phpix engine
// (`apply_runner_flips` in anybuild's run/wasmer.rs), and phpix resolves
// non-file paths to a plain-text 404 before PHP executes — no router
// argument is passed to compensate. Every PHP app that relies on
// `index.php` routing breaks on its next autobuild deploy.
//
// This test asserts the *correct* behavior (upstream PHP built-in-server
// semantics), so it is expected to stay red until ECO-419 is resolved.
// That is intentional: the suite reflects the current state of the product,
// and fixing phpix/anybuild makes this file pass as-is, after which it
// remains the permanent regression test. Please do not skip, quarantine,
// or invert it; coordinate on the ticket instead.

// Single-file router app: every request path is answered by index.php,
// mirroring how framework front controllers (and the php-psql example app)
// dispatch clean URLs.
const ROUTER_INDEX_PHP = `<?php
$path = ltrim(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH), '/');
if ($path === '') {
  echo 'route:root';
} elseif ($path === 'engine') {
  echo 'route:engine';
} else {
  echo 'route:other:' . $path;
}
`;

jest.setTimeout(600_000);

describe("ECO-419 php clean-url routing", () => {
  const cleanupAppIds = installSdkAppCleanup();

  test("clean URL is routed through the docroot index.php", async () => {
    const env = TestEnv.fromEnv();
    const client = await env.stackmachineSdk();

    const app = await deployInlinePhpApp(client, env, ROUTER_INDEX_PHP);
    cleanupAppIds.push(app.id);
    const target = appFetchTarget(app);

    // Sanity: the root URL is served by index.php.
    const rootResponse = await env.fetchApp(target, "/", { forceWait: true });
    expect(rootResponse.status).toBe(200);
    expect(await rootResponse.text()).toBe("route:root");

    // The actual claim: an extension-less path with no matching file on
    // disk falls back to index.php, exactly like native `php -S -t`.
    const engineResponse = await env.fetchApp(target, "/engine", {
      forceWait: true,
    });
    expect(engineResponse.status).toBe(200);
    expect(await engineResponse.text()).toBe("route:engine");
  });
});
