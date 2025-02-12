import * as yaml from "jsr:@std/yaml";
import * as toml from "jsr:@std/toml";

import { buildDir, DirEntry, Path } from "../fs.ts";

// Definition for an app.
// Contains an optional package definition, directory tree and app.yaml configuration.
export interface AppDefinition {
  // TODO: Setup zod object for wasmerToml
  // deno-lint-ignore no-explicit-any
  wasmerToml?: Record<string, any>;
  // TODO: Setup zod object for appYaml
  // deno-lint-ignore no-explicit-any
  appYaml: Record<string, any>;
  files?: DirEntry;
}

export function randomAppName(): string {
  const id = crypto.randomUUID();
  return "t-" + id.replace(/\-/g, "").substr(0, 20);
}

// Build a basic static site `AppDefinition`.
//
// You can tweak the defintion by modifying the files if required.
export function buildStaticSiteApp(): AppDefinition & {
  files: { "public": { "index.html": string } };
} {
  return {
    wasmerToml: {
      dependencies: {
        "wasmer/static-web-server": "1",
      },
      fs: {
        "/public": "public",
        // "/settings": "settings",
      },
      command: [{
        name: "script",
        module: "wasmer/static-web-server:webserver",
        runner: "https://webc.org/runner/wasi",
        // annotations: {
        //   wasi: {
        //     'main-args': ["-w", "/settings/config.toml"],
        //   }
        // }
      }],
    },
    appYaml: {
      kind: "wasmer.io/App.v0",
      name: randomAppName(),
      package: ".",
    },
    files: {
      "public": {
        "index.html": `<html><body>Hello!</body></html>`,
      },
    },
  };
}

// Build a basic javascript worker `AppDefinition`.
//
// You can tweak the defintion by modifying the files if required.
export function buildJsWorkerApp(
  jsCode?: string,
): AppDefinition & { files: { "src": { "index.js": string } } } {
  const DEFAULT_CODE = `
async function handler(request) {
  const out = JSON.stringify({
    env: process.env,
    headers: Object.fromEntries(request.headers),
  }, null, 2);
  return new Response(out, {
    headers: { "content-type": "application/json" },
  });
}

addEventListener("fetch", (fetchEvent) => {
  fetchEvent.respondWith(handler(fetchEvent.request));
});
`;

  const code = jsCode ?? DEFAULT_CODE;

  return {
    wasmerToml: {
      dependencies: {
        "wasmer/winterjs": "1",
      },
      fs: {
        "/src": "src",
        // "/settings": "settings",
      },
      command: [{
        name: "script",
        module: "wasmer/winterjs:winterjs",
        runner: "https://webc.org/runner/wasi",
        annotations: {
          wasi: {
            "main-args": ["/src/index.js"],
          },
        },
      }],
    },
    appYaml: {
      kind: "wasmer.io/App.v0",
      name: randomAppName(),
      package: ".",
    },
    files: {
      "src": {
        "index.js": code,
      },
    },
  };
}

// Write an `AppDefinition` to a directory.
export async function writeAppDefinition(path: Path, app: AppDefinition) {
  const files: DirEntry = {
    ...(app.files ?? {}),
    "app.yaml": yaml.stringify(app.appYaml),
  };
  if (app.wasmerToml) {
    files["wasmer.toml"] = toml.stringify(app.wasmerToml);
  }

  console.debug(`Writing app definition to ${path}`, { files });
  await buildDir(path, files);
}
