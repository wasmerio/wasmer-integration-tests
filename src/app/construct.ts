import * as toml from "@iarna/toml";
import * as yaml from "js-yaml";
import { DirEntry } from "../fs";
import { z } from "zod";
import * as fs from "fs";
import * as pathModule from "path";

export const SECOND = 1000;

export const AppCapabilities = z.object({
  database: z
    .object({
      engine: z.string(),
    })
    .optional(),
  instaboot: z
    .object({
      max_age: z.string().optional(),
      requests: z.array(z.object({})),
    })
    .optional(),
});

export const AppVolumes = z.object({
  name: z.string(),
  mount: z.string(),
});

export const FetchJob = z.object({
  fetch: z.object({
    path: z.string(),
    timeout: z.string(),
  }),
});

export const EnvVars = z.record(z.string(), z.string());

export const ExecJob = z.object({
  execute: z.object({
    command: z.string(),
    env: EnvVars.optional(),
    cli_args: z.array(z.string()).optional(),
  }),
});

// Is this accurate? No idea. Claude thinks so. I believe in our AI overlords
export const cronJobTimeSpec = z
  .string()
  .regex(
    /^(((\d+,)+\d+|(\d+(\/|-)\d+|\d+)(-(\d+(\/\d+)?)?)?|(\*(\/\d+)?)) ?){5,7}$/,
  );

export const JobAction = z.union([ExecJob, FetchJob]);
export type JobAction = z.infer<typeof JobAction>;

export const AppJob = z.object({
  action: JobAction,
  name: z.string(),
  trigger: z.union([
    z.literal("pre-deployment"),
    z.literal("post-deployment"),
    cronJobTimeSpec,
  ]),
});
export type AppJob = z.infer<typeof AppJob>;

export const AppYaml = z.object({
  kind: z.literal("wasmer.io/App.v0"),
  debug: z.boolean().optional(),
  name: z.string().optional(),
  locality: z
    .object({
      regions: z.array(z.string()),
    })
    .optional(),
  owner: z.string().optional(),
  package: z.string(),
  capabilities: AppCapabilities.optional(),
  volumes: z.array(AppVolumes).optional(),
  domains: z.array(z.string()).optional(),
  redirect: z.object({}).optional(),
  scaling: z
    .object({
      mode: z.literal("single_concurrency"),
    })
    .optional(),
  jobs: z.array(AppJob).optional(),
  app_id: z.string().optional(),
  enable_email: z.boolean().optional(),
});

export type AppYaml = z.infer<typeof AppYaml>;

// Definition for an app.
// Contains an optional package definition, directory tree and app.yaml configuration.
export interface AppDefinition {
  // TODO: Setup zod object for wasmerToml
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wasmerToml?: Record<string, any>;
  appYaml: AppYaml;
  files?: DirEntry;
}

export function randomAppName(): string {
  const id = crypto.randomUUID();
  return "t-" + id.replace(/-/g, "").substr(0, 20);
}

// Build a basic static site `AppDefinition`.
//
// You can tweak the defintion by modifying the files if required.
export function buildStaticSiteApp(): AppDefinition & {
  files: { public: { "index.html": string } };
} {
  return {
    wasmerToml: {
      dependencies: {
        "wasmer/static-web-server": "1",
      },
      fs: {
        "/public": "public",
      },
      command: [
        {
          name: "script",
          module: "wasmer/static-web-server:webserver",
          runner: "https://webc.org/runner/wasi",
        },
      ],
    },
    appYaml: {
      kind: "wasmer.io/App.v0",
      name: randomAppName(),
      package: ".",
    },
    files: {
      public: {
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
): AppDefinition & { files: { src: { "index.js": string } } } {
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
      },
      command: [
        {
          name: "script",
          module: "wasmer/winterjs:winterjs",
          runner: "https://webc.org/runner/wasi",
          annotations: {
            wasi: {
              "main-args": ["/src/index.js"],
            },
          },
        },
      ],
    },
    appYaml: {
      kind: "wasmer.io/App.v0",
      name: randomAppName(),
      package: ".",
    },
    files: {
      src: {
        "index.js": code,
      },
    },
  };
}

export const DEFAULT_APP_YAML = {
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
      command: [
        {
          name: "app",
          module: "php/php:php",
          runner: "https://webc.org/runner/wasi",
          annotations: {
            wasi: {
              "main-args": ["-S", "localhost:8080", "/src/index.php"],
            },
          },
        },
      ],
    },
    appYaml: AppYaml.parse({
      ...DEFAULT_APP_YAML,
      ...additionalAppYamlSettings,
    }),
    files: {
      src: {
        "index.php": phpCode,
      },
    },
  };

  return spec;
}

export function buildPythonApp(
  pyCode: string,
  additionalAppYamlSettings?: Record<string, unknown>,
): AppDefinition & { files: { src: { "main.py": string } } } {
  return {
    wasmerToml: {
      dependencies: {
        "wasmer/python": "^3.12.6",
      },
      fs: {
        "/src": "src",
      },
      command: [
        {
          name: "script",
          module: "wasmer/python:python",
          runner: "https://webc.org/runner/wasi",
          annotations: {
            wasi: {
              "main-args": ["/src/main.py"],
            },
          },
        },
      ],
    },
    appYaml: AppYaml.parse({
      ...DEFAULT_APP_YAML,
      ...additionalAppYamlSettings,
    }),
    files: {
      src: {
        "main.py": pyCode,
      },
    },
  };
}

// Write an `AppDefinition` to a directory.
export async function writeAppDefinition(
  path: string,
  app: AppDefinition,
): Promise<void> {
  const files: Record<string, string | object> = {
    ...(app.files ?? {}),
    "app.yaml": yaml.dump(app.appYaml),
  };

  if (app.wasmerToml) {
    files["wasmer.toml"] = toml.stringify(app.wasmerToml);
  }

  console.debug(`Writing app definition to ${path}`, { files });

  async function buildDir(
    basePath: string,
    dirContent: Record<string, string | object>,
  ): Promise<void> {
    await Promise.all(
      Object.entries(dirContent).map(async ([name, content]) => {
        const fullPath: string = pathModule.join(basePath, name);
        if (typeof content === "string") {
          await fs.promises.mkdir(pathModule.dirname(fullPath), {
            recursive: true,
          });
          await fs.promises.writeFile(fullPath, content);
        } else {
          await fs.promises.mkdir(fullPath, { recursive: true });
          await buildDir(fullPath, content as Record<string, string | object>);
        }
      }),
    );
  }

  await buildDir(path, files);
}

export function loadAppYaml(path: string): AppYaml {
  try {
    const fileContent = fs.readFileSync(
      pathModule.join(path, "app.yaml"),
      "utf-8",
    );
    return AppYaml.parse(yaml.load(fileContent));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error instanceof Error) {
      throw new Error(`Failed to load AppYaml from ${path}: ${error.message}`);
    } else {
      throw error;
    }
  }
}

export function saveAppYaml(path: string, appYaml: AppYaml): void {
  try {
    fs.writeFileSync(
      pathModule.join(path, "app.yaml"),
      JSON.stringify(appYaml, null, 2),
    );
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to save AppYaml to ${path}: ${error.message}`);
    } else {
      throw error;
    }
  }
}
