// The anchor-app fixture registry: what `apps.fixture` names resolve to.
// Shapes mirror src/app/construct.ts's builders (static site, winterjs
// worker, PHP, Python) but are written self-contained — the seeder spawns
// the wasmer CLI directly and must not drag the TestEnv dependency tree
// into the engine. Every fixture's page identifies its app and fixture, so
// a browser or probe can tell the mix apart. All dependency packages are
// auto-mirrored into the local registry (the platform discovers them from
// the src/app constructors; verified live 2026-08-14).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const FIXTURE_NAMES = [
  "static-site",
  "js-worker",
  "php",
  "python",
] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

interface FixtureSpec {
  wasmerToml: string;
  /** Relative path -> content, in addition to app.yaml + wasmer.toml. */
  files: (name: string) => Record<string, string>;
}

const toml = (lines: string[]): string => lines.join("\n") + "\n";

const SPECS: Record<FixtureName, FixtureSpec> = {
  "static-site": {
    wasmerToml: toml([
      "[dependencies]",
      '"wasmer/static-web-server" = "1"',
      "",
      "[fs]",
      '"/public" = "public"',
      "",
      "[[command]]",
      'name = "script"',
      'module = "wasmer/static-web-server:webserver"',
      'runner = "https://webc.org/runner/wasi"',
    ]),
    files: (name) => ({
      "public/index.html": `<html><body><h1>${name}</h1><p>simulated anchor app (static-site)</p></body></html>\n`,
    }),
  },
  "js-worker": {
    wasmerToml: toml([
      "[dependencies]",
      '"wasmer/winterjs" = "1"',
      "",
      "[fs]",
      '"/src" = "src"',
      "",
      "[[command]]",
      'name = "script"',
      'module = "wasmer/winterjs:winterjs"',
      'runner = "https://webc.org/runner/wasi"',
      "",
      "[command.annotations.wasi]",
      'main-args = ["/src/index.js"]',
    ]),
    files: (name) => ({
      "src/index.js": [
        "async function handler(request) {",
        `  const body = JSON.stringify({ app: "${name}", fixture: "js-worker", path: new URL(request.url).pathname });`,
        '  return new Response(body, { headers: { "content-type": "application/json" } });',
        "}",
        'addEventListener("fetch", (event) => { event.respondWith(handler(event.request)); });',
        "",
      ].join("\n"),
    }),
  },
  php: {
    wasmerToml: toml([
      "[dependencies]",
      '"php/php" = "8.*"',
      "",
      "[fs]",
      '"/src" = "src"',
      "",
      "[[command]]",
      'name = "run"',
      'module = "php/php:php"',
      'runner = "wasi"',
      "",
      "[command.annotations.wasi]",
      'main-args = ["-t", "/src", "-S", "localhost:8080"]',
    ]),
    files: (name) => ({
      "src/index.php": [
        "<?php",
        "header('Content-Type: application/json');",
        `echo json_encode(['app' => '${name}', 'fixture' => 'php']);`,
        "",
      ].join("\n"),
    }),
  },
  python: {
    wasmerToml: toml([
      "[dependencies]",
      '"wasmer/python" = "^3.12.6"',
      "",
      "[fs]",
      '"/src" = "src"',
      "",
      "[[command]]",
      'name = "script"',
      'module = "wasmer/python:python"',
      'runner = "https://webc.org/runner/wasi"',
      "",
      "[command.annotations.wasi]",
      'main-args = ["/src/main.py"]',
    ]),
    files: (name) => ({
      "src/main.py": [
        "from http.server import HTTPServer, BaseHTTPRequestHandler",
        "",
        "",
        "class Handler(BaseHTTPRequestHandler):",
        "    def do_GET(self):",
        `        body = b'{"app": "${name}", "fixture": "python"}'`,
        "        self.send_response(200)",
        '        self.send_header("Content-Type", "application/json")',
        '        self.send_header("Content-Length", str(len(body)))',
        "        self.end_headers()",
        "        self.wfile.write(body)",
        "",
        "    def log_message(self, *args):",
        "        pass",
        "",
        "",
        'HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()',
        "",
      ].join("\n"),
    }),
  },
};

/** Materialize a fixture's app directory (wasmer.toml + app.yaml + files). */
export function writeFixtureApp(
  fixture: FixtureName,
  dir: string,
  name: string,
  namespace: string,
): void {
  const spec = SPECS[fixture];
  writeFileSync(path.join(dir, "wasmer.toml"), spec.wasmerToml);
  writeFileSync(
    path.join(dir, "app.yaml"),
    [
      "kind: wasmer.io/App.v0",
      `name: ${name}`,
      `owner: ${namespace}`,
      "package: .",
      "",
    ].join("\n"),
  );
  for (const [relative, content] of Object.entries(spec.files(name))) {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** The package a fixture's fabricated versions claim (cosmetic — only real
 * anchors deploy; fabricated rows carry it in their yaml_config). */
export function fixturePackage(fixture: FixtureName): string {
  switch (fixture) {
    case "static-site":
      return "wasmer/static-web-server";
    case "js-worker":
      return "wasmer/winterjs";
    case "php":
      return "php/php";
    case "python":
      return "wasmer/python";
  }
}
