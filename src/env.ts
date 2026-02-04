import * as path from "node:path";
import * as fs from "node:fs";
import * as process from "node:process";
import * as toml from "@iarna/toml";
import { promises as dns } from "dns";

import { spawn, SpawnOptions } from "child_process";

import { AppInfo, BackendClient } from "./backend";
import {
  DeployOutput,
  loadWasmerConfig,
  parseDeployOutput,
} from "./wasmer_cli";
import { buildTempDir, Path } from "./fs";
import { sleep } from "./util";
import {
  AppDefinition,
  randomAppName,
  writeAppDefinition,
} from "./app/construct";
import { AppGet } from "./app/appGet";
import { HEADER_APP_VERSION_ID, HEADER_WASMER_REQUEST_ID } from "./edge";

export const ENV_VAR_REGISTRY: string = "WASMER_REGISTRY";
export const ENV_VAR_NAMESPACE: string = "WASMER_NAMESPACE";
export const ENV_VAR_TOKEN: string = "WASMER_TOKEN";
export const ENV_VAR_APP_DOMAIN: string = "WASMER_APP_DOMAIN";
export const ENV_VAR_EDGE_SERVER: string = "EDGE_SERVER";
export const ENV_VAR_WASMER_PATH: string = "WASMER_PATH";
export const ENV_VAR_WASMOPTICON_DIR: string = "WASMOPTICON_DIR";
export const ENV_VAR_VERBOSE: string = "VERBOSE";
export const ENV_VAR_MAX_PRINT_LENGTH: string = "MAX_LINE_PRINT_LENGTH";

export const REGISTRY_DEV: string = "https://registry.wasmer.wtf/graphql";
export const REGISTRY_BUGT: string = "https://registry.wasmer.fun/graphql";
export const REGISTRY_PROD: string = "https://registry.wasmer.io/graphql";
export const REGISTRY_LOCAL: string = "http://localhost:8003/graphql";

export const appDomainMap = {
  [REGISTRY_PROD]: "wasmer.app",
  [REGISTRY_BUGT]: "wasmerfun.app",
  [REGISTRY_DEV]: "wasmer.dev",
  [REGISTRY_LOCAL]: "localhost",
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
  // Explicitly try to wait for version to be deployed. The logic to determine if app should wait or not is
  // quite heavy cognitive load, and causes integration test failures if altered. This field is appended
  // to handle edge cases when we most certainly want to wait
  forceWait?: boolean;
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

  backend: BackendClient;

  // Logging settings
  verbose = false;
  maxRowLength = 300;

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
        maybeToken =
          config.registry?.tokens?.find((t) => t.registry === registry)
            ?.token ?? null;
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

    const env = new TestEnv(registry, token, namespace, appDomain);

    if (edgeServer) {
      env.edgeServer = edgeServer;
    }

    if (wasmerBinary) {
      env.wasmerBinary = wasmerBinary;
    }

    if (maybeToken) {
      env.token = maybeToken;
    }

    const verbose = process.env[ENV_VAR_VERBOSE];
    if (verbose) {
      env.verbose = true;
    }

    return env;
  }

  private constructor(
    registry: string,
    token: string,
    namespace: string,
    appDomain: string,
  ) {
    this.registry = registry;
    this.namespace = namespace;
    this.appDomain = appDomain;

    this.backend = new BackendClient(registry, token);
    this.token = token;
  }

  async runWasmerCommand(options: CommandOptions): Promise<CommandOutput> {
    const args = options.args;
    const env = { ...process.env, ...options.env };

    if (!args.includes("--registry")) {
      env["WASMER_REGISTRY"] = this.registry;
    }
    if (!args.includes("--token")) {
      env["WASMER_TOKEN"] = this.token;
    }

    const spawnOpts: SpawnOptions = {
      cwd: options.cwd,
      env,
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    };

    // Create a copy and then unset env if env has been printed
    const printSpawn = { args: args, ...spawnOpts };
    if (!this.verbose) {
      printSpawn.env = { OBFUSCATED: "Rerun with VERBOSE=true to see." };
    }
    console.debug("Running command...", printSpawn);
    const proc = spawn(this.wasmerBinary, args, spawnOpts);

    if (options.stdin) {
      proc.stdin!.write(options.stdin);
      proc.stdin!.end();
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    console.debug("command output >>>");

    const collectOutput = (
      stream: NodeJS.ReadableStream,
      chunks: Buffer[],
    ): Promise<void> => {
      return new Promise((resolve) => {
        stream.on("data", (chunk: Buffer) => {
          let chunkStr = chunk.toString("utf8");
          if (!this.verbose && chunkStr.length > this.maxRowLength) {
            chunkStr =
              chunkStr.substring(0, this.maxRowLength - 3) +
              "... and " +
              (chunkStr.length - this.maxRowLength) +
              " more characters (env var VERBOSE=true to see all)";
          }
          console.debug(chunkStr);
          chunks.push(chunk);
        });
        stream.on("end", resolve);
      });
    };

    const [code] = await Promise.all([
      new Promise<number>((resolve) => proc.on("exit", resolve)),
      collectOutput(proc.stdout!, stdoutChunks),
      collectOutput(proc.stderr!, stderrChunks),
    ]);

    const stdout = Buffer.concat(stdoutChunks).toString();
    const stderr = Buffer.concat(stderrChunks).toString();

    console.log(`<<< command finished with code ${code}`);

    const result: CommandOutput = { code, stdout, stderr };
    if (this.verbose) {
      console.debug("Command executed:", result);
    }

    if (code !== 0 && options.noAssertSuccess !== true) {
      const data = JSON.stringify(result, null, 2);
      throw new Error(`Command failed: ${data}`);
    }

    return result;
  }

  // Ensure that a NAMED package at a given path is published.
  //
  // Returns the package name.
  async ensurePackagePublished(dir: Path): Promise<PackageIdent> {
    const manifsetPath = path.join(dir, "wasmer.toml");
    const manifestRaw = await fs.promises.readFile(manifsetPath, "utf-8");

    // TODO: Setup zod object for manifest files
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    const args = ["publish", "--bump", dir];

    console.debug(`Publishing package at '${dir}'...`);
    await this.runWasmerCommand({ args });

    return name;
  }

  async getAppGetFromDir(dir: string): Promise<AppGet> {
    const args: string[] = ["app", "get", "--format", "json"];
    const { stdout } = await this.runWasmerCommand({
      args,
      cwd: dir,
    });

    return AppGet.parse(JSON.parse(stdout));
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

  // wasmerAppGet returns more info than app info, using command wasmer app get <app-id>
  async wasmerAppGet(appID: string): Promise<AppGet> {
    const args: string[] = ["app", "get", appID, "--format", "json"];
    const { stdout } = await this.runWasmerCommand({
      args,
    });
    return AppGet.parse(JSON.parse(stdout));
  }

  async getAppPermalinkID(appID: string): Promise<string> {
    const appInfo = await this.backend.getAppById(appID);
    const permalink = appInfo.permalink;
    if (!permalink) {
      throw new Error(`Missing permalink for app ${appID}`);
    }
    const match = permalink.match(
      /^https?:\/\/([a-z0-9-]+)\.id\.wasmer(fun){0,1}\.(?:app|dev)(?:\/|$)/i,
    );
    if (!match) {
      throw new Error(`Invalid permalink format: ${permalink}`);
    }
    return match[1];
  }

  async *graphqlSubscription(
    endpoint: string,
    token: string,
    query: string,
    variables = {},
    heartbeatInterval = 1000, // each second
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): AsyncGenerator<any, void, unknown> {
    const socket = new WebSocket(endpoint, ["graphql-ws"]);
    // generate a random subscription_id
    const subscription_id = Math.random().toString(36).substring(7);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendMessage = (message: any) => {
      socket.send(JSON.stringify(message));
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const waitForEvent = (type: any) =>
      new Promise((resolve) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handler = (event: any) => {
          const response = JSON.parse(event.data);
          if (response.type == "error") {
            console.error(response);
            resolve(response);
            console.log(JSON.stringify(response));
          }
          if (response.type == "complete") {
            resolve(response);
            console.log(JSON.stringify(response));
          }

          if (response.type === type) {
            socket.removeEventListener("message", handler);
            resolve(response);
          } else {
            console.log(JSON.stringify(response));
          }
        };
        socket.addEventListener("message", handler);
      });

    socket.onopen = () => {
      sendMessage({
        type: "connection_init",
        payload: { headers: { Authorization: `Bearer ${token}` } },
      });
    };

    await waitForEvent("connection_ack");

    sendMessage({
      id: subscription_id,
      type: "start",
      payload: { query, variables },
    });

    // Send heartbeat (ping) messages periodically
    const heartbeatIntervalId = setInterval(() => {
      sendMessage({ type: "ping" });
    }, heartbeatInterval);

    try {
      while (true) {
        const response = await waitForEvent("data");
        yield response;
      }
    } finally {
      socket.close();
      clearInterval(heartbeatIntervalId);
    }
  }

  async deployAppFromRepo(
    repo: string,
    extra_data: Record<string, unknown> = {},
    branch: string | null = null,
  ): Promise<string | undefined> {
    const registry = this.registry;
    const token = "";
    const query = `
subscription PublishAppFromRepoAutobuild(
  $repoUrl: String!
  $appName: String!
  $extraData: AutobuildDeploymentExtraData = null
  $branch: String = null
) {
  publishAppFromRepoAutobuild(
    repoUrl: $repoUrl
    appName: $appName
    managed: true
    waitForScreenshotGeneration: false
    extraData: $extraData
    branch: $branch
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
      branch: branch,
    };
    for await (const res of this.graphqlSubscription(
      registry,
      token,
      query,
      variables,
    )) {
      if (res.errors) {
        console.error(res.errors);
      }
      const msg = res.payload?.data?.publishAppFromRepoAutobuild?.message;
      if (msg) {
        console.log(msg);
      }
      const payload = res.payload;
      if (payload?.data?.publishAppFromRepoAutobuild?.kind === "COMPLETE") {
        return res.payload.data.publishAppFromRepoAutobuild.appVersion?.app
          ?.url;
      }
    }
  }

  // Resolve the A/AAAA records for the main app domain.
  //
  // Uses the Edge DNS servers.
  async resolveAppDns(app: AppInfo): Promise<{ a: string[]; aaaa: string[] }> {
    const domain = new URL(app.url).host;

    const resolver = new dns.Resolver();

    // Get edge server IP
    try {
      const edgeServerIps = await resolver.resolve4(this.appDomain);
      if (edgeServerIps.length === 0) {
        throw new Error(
          `Could not DNS-resolve IPs found for app domain ${this.appDomain}`,
        );
      }

      if (this.edgeServer) {
        resolver.setServers([this.edgeServer]);
      } else {
        resolver.setServers([edgeServerIps[0]]);
      }

      const [a, aaaa] = await Promise.all([
        resolver.resolve4(domain).catch(() => []),
        resolver.resolve6(domain).catch(() => []),
      ]);

      return { a, aaaa };
    } catch (err) {
      if (err.code !== "ENODATA" && err.code !== "ENOTFOUND") {
        throw err;
      }
      return { a: [], aaaa: [] };
    }
  }

  async fetchApp(
    app: AppInfo,
    urlOrPath: string,
    options: AppFetchOptions = {},
  ): Promise<Response> {
    let url: string;
    if (this.edgeServer) {
      if (!options.headers) {
        options.headers = {};
      }
      options.headers["host"] = url;
      url = this.edgeServer;
    }
    if (urlOrPath.startsWith("http")) {
      url = urlOrPath;
    } else {
      url = app.url + (urlOrPath.startsWith("/") ? "" : "/") + urlOrPath;
    }

    let waitForVersionId: string | null = null;
    if (
      (!options.noWait && !urlOrPath.startsWith("http")) ||
      options.forceWait
    ) {
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
      const response = await fetch(url, options);
      console.debug(`Fetched URL ${url}`);
      if (this.verbose) {
        console.debug({
          status: response.status,
          headers: response.headers,
        });
      }

      if (!options.noAssertSuccess && !response.ok) {
        console.error(
          "Response is not OK! We can't check why as that breaks some tests. Continuing",
        );
      }

      // NOTE: this step happens after the success check on purpose, because
      // another error like a 404 indicates problems in the deployment flow.
      if (waitForVersionId) {
        const requestId = response.headers.get(HEADER_WASMER_REQUEST_ID);
        if (!requestId) {
          throw new Error(
            `Failed to fetch URL '${url}': missing ${HEADER_WASMER_REQUEST_ID} header in response - does not seem to be served by Edge`,
          );
        }

        const currentId = response.headers.get(HEADER_APP_VERSION_ID);

        if (currentId !== waitForVersionId) {
          let msg = "";
          if (!currentId) {
            msg = `missing ${HEADER_APP_VERSION_ID} header in response - app does not seem to be published yet`;
          } else {
            msg = `expected version ${waitForVersionId}, got ${currentId}`;
          }

          const elapsed = Date.now() - start;
          // only retry for one minute
          if (elapsed > RETRY_TIMEOUT_SECS * 1000) {
            throw new Error(
              `Failed to fetch URL '${url}': ${msg} (retried for ${RETRY_TIMEOUT_SECS} seconds)`,
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
