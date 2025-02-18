import { AppDefinition, AppYaml, randomAppName } from "./construct.ts";

export const DEFAULT_PHP_APP_YAML = {
  kind: "wasmer.io/App.v0",
  name: randomAppName(),
  package: ".",
};

export function buildPhpApp(
  phpCode: string,
  additionalAppYamlSettings?: Record<string, unknown>,
): AppDefinition {
  const spec: AppDefinition = {
    wasmerToml: {
      dependencies: {
        "php/php": "8.*",
      },
      fs: {
        "/src": "src",
      },
      command: [{
        name: "app",
        module: "php/php:php",
        runner: "https://webc.org/runner/wasi",
        annotations: {
          wasi: {
            "main-args": ["-S", "localhost:8080", "/src/index.php"],
          },
        },
      }],
    },
    appYaml: AppYaml.parse({
      ...DEFAULT_PHP_APP_YAML,
      ...additionalAppYamlSettings,
    }),
    files: {
      "src": {
        "index.php": phpCode,
      },
    },
  };

  return spec;
}
