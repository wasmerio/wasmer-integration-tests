import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import * as toml from "jsr:@std/toml";

import { HttpClient } from "./http.ts";
import { AppInfo, BackendClient } from "./backend.ts";
import {
  DeployOutput,
  loadWasmerConfig,
  parseDeployOutput,
} from "./wasmer_cli.ts";
import { buildTempDir, Path } from "./fs.ts";
import { sleep } from "./util.ts";
import {
  AppDefinition,
  randomAppName,
  writeAppDefinition,
} from "./app/construct.ts";

export const ENV_VAR_REGISTRY: string = "WASMER_REGISTRY";
export const ENV_VAR_NAMESPACE: string = "WASMER_NAMESPACE";
export const ENV_VAR_TOKEN: string = "WASMER_TOKEN";
export const ENV_VAR_APP_DOMAIN: string = "WASMER_APP_DOMAIN";
export const ENV_VAR_EDGE_SERVER: string = "EDGE_SERVER";
export const ENV_VAR_WASMER_PATH: string = "WASMER_PATH";
export const ENV_VAR_WASMOPTICON_DIR: string = "WASMOPTICON_DIR";

export const REGISTRY_DEV: string = "https://registry.wasmer.wtf/graphql";
export const REGISTRY_PROD: string = "https://registry.wasmer.io/graphql";

export const appDomainMap = {
  [REGISTRY_PROD]: "wasmer.app",
  [REGISTRY_DEV]: "wasmer.dev",
};

export const DEFAULT_NAMESPACE: string = "wasmer-integration-tests";

export type PackageIdent = string;

export interface CommandOptions {
  args: string[];
  cwd?: Path;
  env?: Record<string, string>;
  stdin?: string;
  noAssertSuccess?: boolean;
}

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DeployOptions {
  extraCliArgs?: string[];
  noWait?: boolean;
}

export interface AppFetchOptions extends RequestInit {
  // Ignore non-success status codes.
  noAssertSuccess?: boolean;
  // Discard the response body.
  discardBody?: boolean;
  // Do not wait for the latest version to be deployed.
  noWait?: boolean;
}

export class TestEnv {
  registry: string;
  namespace: string;
  appDomain: string;

  // Backend token.
  token: string;

  /// IP or hostname of the specific Edge server to test.
  edgeServer: string | null = null;

  // Name or path of the `wasmer` binary to use.
  wasmerBinary: string = "wasmer";

  httpClient: HttpClient;
  backend: BackendClient;

  static fromEnv(): TestEnv {
    const registry = process.env[ENV_VAR_REGISTRY] ?? REGISTRY_DEV;
    const namespace = process.env[ENV_VAR_NAMESPACE] ?? DEFAULT_NAMESPACE;

    const appDomainEnv = process.env[ENV_VAR_APP_DOMAIN];

    let appDomain: string;
    if (registry in appDomainMap) {
      appDomain = appDomainMap[registry];
    } else if (appDomainEnv) {
      appDomain = appDomainEnv;
    } else {
      throw new Error(
        `Could not determine the app domain for registry ${registry}:
	Set the ${ENV_VAR_APP_DOMAIN} env var!`,
      );
    }

    const edgeServer = process.env[ENV_VAR_EDGE_SERVER];
    const wasmerBinary = process.env[ENV_VAR_WASMER_PATH];
    let maybeToken: string | null = process.env[ENV_VAR_TOKEN] ?? null;

    // If token is not set, try to read it from the wasmer config.
    // The token is needed for API requests.
    if (!maybeToken) {
      try {
        const config = loadWasmerConfig();
        maybeToken = config.registry?.tokens?.find((t) =>
          t.registry === registry
        )?.token ?? null;
        if (!maybeToken) {
          throw new Error(
            `Could not find token for registry ${registry} in wasmer.toml config - \
            specify the token with the WASMER_TOKEN env var`,
          );
        }
      } catch (err) {
        if (err instanceof Error) {
          throw new Error(
            `Failed to load wasmer.toml config - specify the WASMER_TOKEN env var to provide a token without a config (error: ${err.toString()})`,
          );
        }
      }
    }

    const token: string = maybeToken ? maybeToken : "TOKEN NOT SET";

    const httpClient = new HttpClient();
    if (edgeServer) {
      httpClient.targetServer = edgeServer;
    }

    const env = new TestEnv(
      registry,
      token,
      namespace,
      appDomain,
      httpClient,
    );

    if (edgeServer) {
      env.edgeServer = edgeServer;
    }

    if (wasmerBinary) {
      env.wasmerBinary = wasmerBinary;
    }

    if (maybeToken) {
      env.token = maybeToken;
    }

    return env;
  }

  private constructor(
    registry: string,
    token: string,
    namespace: string,
    appDomain: string,
    client: HttpClient,
  ) {
    this.registry = registry;
    this.namespace = namespace;
    this.appDomain = appDomain;

    this.httpClient = client;
    this.backend = new BackendClient(registry, token);
    this.token = token;
  }

  async runWasmerCommand(options: CommandOptions): Promise<CommandOutput> {
    const cmd = this.wasmerBinary;
    const args = options.args;

    const env = options.env ?? {};
    if (!args.includes("--registry")) {
      env["WASMER_REGISTRY"] = this.registry;
    }
    if (!args.includes("--token")) {
      env["WASMER_TOKEN"] = this.token;
    }

    const copts: Deno.CommandOptions = {
      cwd: options.cwd,
      args,
      env,
      stdin: options.stdin ? "piped" : "null",
    };

    console.debug("Running command...", copts);
    const command = new Deno.Command(cmd, {
      ...copts,
      stdout: "piped",
      stderr: "piped",
    });

    // create subprocess and collect output
    const proc = command.spawn();

    if (options.stdin) {
      const writer = proc.stdin.getWriter();
      await writer.write(new TextEncoder().encode(options.stdin));
      await writer.releaseLock();
      await proc.stdin.close();
    }

    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];

    function mergeChunks(chunks: Uint8Array[]): BufferSource {
      const ret = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
      chunks.reduce((offset, chunk) => {
        ret.set(chunk, offset);
        return offset + chunk.length;
      }, 0);
      return ret;
    }

    const collectAndPrint = async (
      readable: ReadableStream<Uint8Array>,
      chunks: Uint8Array[],
    ) => {
      const reader = readable.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          await Deno.stdout.write(value); // Print while reading
          chunks.push(value); // Collect to array
        }
        if (done) {
          break;
        }
      }
    };

    console.log("command output >>>");

    // Need to run concurrently to avoid blocking due to full stdout/stderr buffers.

    const stdoutRes = collectAndPrint(proc.stdout, stdoutChunks);
    const stderrRes = collectAndPrint(proc.stderr, stderrChunks);
    const procResult = await proc.status;

    await stdoutRes;
    const stdout = new TextDecoder().decode(mergeChunks(stdoutChunks));
    await stderrRes;
    const stderr = new TextDecoder().decode(mergeChunks(stderrChunks));

    const code = procResult.code;
    console.log(`<<< command finished with code ${code}`);

    const result: CommandOutput = {
      code,
      stdout,
      stderr,
    };

    console.debug("Command executed:", result);

    if (code !== 0 && options.noAssertSuccess !== true) {
      const data = JSON.stringify(result, null, 2);
      throw new Error(`Command failed: ${data}`);
    }

    return result;
  }

  // Ensure that a NAMED package at a given path is published.
  //
  // Returns the package name.
  async ensurePackagePublished(
    dir: Path,
  ): Promise<PackageIdent> {
    const manifsetPath = path.join(dir, "wasmer.toml");
    const manifestRaw = await fs.promises.readFile(manifsetPath, "utf-8");

    // TODO: Setup zod object for manifest files
    // deno-lint-ignore no-explicit-any
    let manifest: any;
    try {
      manifest = toml.parse(manifestRaw);
    } catch (err) {
      throw new Error(
        `Failed to parse package manifest at '${manifsetPath}': ${err}`,
      );
    }

    const name = manifest?.package?.name;
    if (typeof name !== "string") {
      throw new Error(
        `Invalid package manifest: missing package name: ${manifestRaw}`,
      );
    }
    const parts = name.split("/");
    if (parts.length !== 2) {
      throw new Error(
        `Invalid package name: expected 'owner/name', got '${name}'`,
      );
    }

    const args = [
      "publish",
      "--bump",
      dir,
    ];

    console.debug(`Publishing package at '${dir}'...`);
    await this.runWasmerCommand({ args });

    return name;
  }

  async deployAppDir(dir: Path, options?: DeployOptions): Promise<AppInfo> {
    const extraArgs = options?.extraCliArgs ?? [];
    const noWait = options?.noWait ?? false;

    const args: string[] = [
      "deploy",
      "--non-interactive",
      "--format",
      "json",
      ...extraArgs,
    ];

    // If a specific server should be tested, don't wait for the deployment to
    // succeed, because the CLI might not test the specific server.
    if (noWait || this.edgeServer) {
      args.push("--no-wait");
    }

    const { stdout } = await this.runWasmerCommand({
      args,
      cwd: dir,
    });

    const version = parseDeployOutput(stdout, dir);
    const info = await this.resolveAppInfoFromVersion(version, dir);

    if (this.edgeServer && !noWait) {
      // Specific target server, but waiting is enabled, so manually test.
      await this.fetchApp(info, "/");
    }

    console.debug("App deployed", { info });
    return info;
  }

  async resolveAppInfoFromVersion(
    version: DeployOutput,
    dir: Path,
  ): Promise<AppInfo> {
    // Load app from backend.
    const app = await this.backend.getAppById(version.appId);
    const info: AppInfo = {
      version,
      app,

      id: version.appId,
      url: app.url,
      dir,
    };

    return info;
  }

  async deployApp(
    spec: AppDefinition,
    options?: DeployOptions,
  ): Promise<AppInfo> {
    // Stub in values.
    if (!spec.appYaml.owner) {
      spec.appYaml.owner = this.namespace;
    }
    if (!spec.appYaml.name) {
      spec.appYaml.name = randomAppName();
    }
    if (!spec.appYaml.domains) {
      spec.appYaml.domains = [spec.appYaml.name + "." + this.appDomain];
    }

    const dir = await buildTempDir(spec.files ?? {});
    await writeAppDefinition(dir, spec);
    return this.deployAppDir(dir, options);
  }

  async deleteApp(app: AppInfo): Promise<void> {
    await this.runWasmerCommand({
      args: ["app", "delete", app.id],
    });
  }

  async *graphqlSubscription(
    endpoint: string,
    token: string,
    query: string,
    variables = {},
  ): AsyncGenerator<any, void, unknown> {
    const socket = new WebSocket(endpoint, ["graphql-ws"]);

    const sendMessage = (message: any) => {
      socket.send(JSON.stringify(message));
    };

    const waitForEvent = (type: any) =>
      new Promise((resolve) => {
        const handler = (event: any) => {
          const response = JSON.parse(event.data);
          if (response.type == "error") {
            console.error(response);
            resolve(response);
          }
          if (response.type === type) {
            socket.removeEventListener("message", handler);
            resolve(response);
          }
        };
        socket.addEventListener("message", handler);
      });

    socket.onopen = () => {
      console.log("WebSocket connection established.");
      sendMessage({
        type: "connection_init",
        payload: { headers: { Authorization: `Bearer ${token}` } },
      });
    };

    await waitForEvent("connection_ack");

    sendMessage({ id: "1", type: "start", payload: { query, variables } });

    try {
      while (true) {
        const response = await waitForEvent("data");
        yield response;
      }
    } finally {
      socket.close();
    }
  }

  async deployAppFromRepo(
    repo: string,
    extra_data: Record<string, unknown> = {},
  ): Promise<string | undefined> {
    const registry = this.registry;
    const token = "";
    const query = `
subscription PublishAppFromRepoAutobuild(
  $repoUrl: String!
  $appName: String!
  $extraData: AutobuildDeploymentExtraData = null
) {
  publishAppFromRepoAutobuild(
    repoUrl: $repoUrl
    appName: $appName
    managed: true
    waitForScreenshotGeneration: false
    extraData: $extraData
  ) {
    kind
    message
    dbPassword
    appVersion {
      app {
        url
      }
    }
  }
}`;
    const variables = {
      repoUrl: repo,
      appName: crypto.randomUUID().split("-").join("").slice(0, 10),
      extraData: extra_data,
    };
    for await (
      const res of this.graphqlSubscription(registry, token, query, variables)
    ) {
      res.errors && console.error(res.errors);
      console.log(res.payload);
      let msg = res.payload.data?.publishAppFromRepoAutobuild?.message;
      if (msg) {
        console.log(msg);
      }
      if (res.payload.data?.publishAppFromRepoAutobuild?.kind === "COMPLETE") {
        return res.payload.data?.publishAppFromRepoAutobuild?.appVersion?.app
          ?.url;
      }
    }
  }

  async fetchApp(
    app: AppInfo,
    urlOrPath: string,
    options: AppFetchOptions = {},
  ): Promise<Response> {
    let url: string;
    if (urlOrPath.startsWith("http")) {
      url = urlOrPath;
    } else {
      url = app.url + (urlOrPath.startsWith("/") ? "" : "/") + urlOrPath;
    }

    let waitForVersionId: string | null = null;
    if (!options.noWait && !urlOrPath.startsWith("http")) {
      // Fetch latest version
      const info = await this.backend.getAppById(app.id);
      waitForVersionId = info.activeVersionId;
    }

    // Should not follow redirects by default.
    if (!options.redirect) {
      options.redirect = "manual";
    }

    const start = Date.now();
    const RETRY_TIMEOUT_SECS = 60;
    while (true) {
      console.debug(`Fetching URL ${url}`, { options });
      const response = await this.httpClient.fetch(url, options);
      console.debug(`Fetched URL ${url}`, {
        status: response.status,
        headers: response.headers,
        remoteAddress: response.remoteAddress,
      });

      // if (options.discardBody) {
      //   await response.body?.cancel();
      // }
      if (!options.noAssertSuccess && !response.ok) {
        // Try to get the body:
        let body: string | null = null;
        try {
          body = await response.text();
        } catch (err) {
          console.error(err);
        }

        // TODO: allow running against a particular server.
        throw new Error(
          `Failed to fetch URL '${url}': ${response.status}\n\nBODY:\n${body}`,
        );
      }

      // NOTE: this step happens after the success check on purpose, because
      // another error like a 404 indicates problems in the deployment flow.
      if (waitForVersionId) {
        const currentId = response.headers.get("x-edge-app-version-id");
        if (!currentId) {
          throw new Error(
            `Failed to fetch URL '${url}': missing x-edge-app-version-id header`,
          );
        }

        if (currentId !== waitForVersionId) {
          const elapsed = Date.now() - start;
          // only retry for one minute
          if (elapsed > (RETRY_TIMEOUT_SECS * 1000)) {
            throw new Error(
              `Failed to fetch URL '${url}': app is not at expected version ${waitForVersionId} after retrying for ${RETRY_TIMEOUT_SECS} seconds (got ${currentId})`,
            );
          }

          console.info(
            `App is not at expected version ${waitForVersionId} (got ${currentId}), retrying after delay...`,
          );
          await sleep(1000);
          // Retry...
          continue;
        } else {
          console.debug(`App is at expected version ${waitForVersionId}`);
        }
      }

      return response;
    }
  }
}
