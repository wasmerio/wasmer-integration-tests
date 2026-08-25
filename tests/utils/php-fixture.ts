import * as fs from "node:fs";
import * as pathModule from "node:path";

import { AppDefinition, AppYaml } from "../../src/index";
import { defaultAppYaml } from "../../src/app/construct";
import { projectRoot } from "./path";

// Deployment of the PHP fixture (fixtures/php/fixture), the PHP
// implementation of the HTTP fixture contract. Runs on the phpix engine —
// the production PHP runtime (native multi-threaded server with an
// in-process PHP pool) — in the same shape production apps use: the engine
// as a package dependency serving the docroot. Deploys as a plain package
// app (no remote build involved), so it is fast compared to the
// node/python fixtures.

export const PHP_FIXTURE_DEPLOY_TIMEOUT = 10 * 60 * 1000;

const PHPIX_PKG = "phpix/phpix-83-64bit";

export function buildPhpFixtureApp(
  additionalAppYamlSettings?: Record<string, unknown>,
): AppDefinition {
  const code = fs.readFileSync(
    pathModule.join(projectRoot, "fixtures", "php", "fixture", "index.php"),
    "utf-8",
  );
  return {
    wasmerToml: {
      dependencies: {
        // The 0.3.0-rc line is the first with clean-URL routing (ECO-419),
        // which the single-router fixture needs; a bare `*` resolves to the
        // pre-fix 0.2.2 (semver excludes prereleases). Production anybuild
        // pins the same line, and the Edge package override rewrites phpix
        // at instance start wherever one is configured.
        [PHPIX_PKG]: "=0.3.0-rc.5",
      },
      fs: {
        "/src": "src",
      },
      command: [
        {
          name: "app",
          module: `${PHPIX_PKG}:phpix`,
          runner: "https://webc.org/runner/wasi",
          annotations: {
            wasi: {
              "main-args": ["-S", "localhost:8080", "-t", "/src"],
            },
          },
        },
      ],
    },
    appYaml: AppYaml.parse({
      ...defaultAppYaml(),
      volumes: [{ name: "data", mount: "/data" }],
      ...additionalAppYamlSettings,
    }),
    files: {
      src: {
        "index.php": code,
      },
    },
  };
}
