import { assertEquals, assertNotEquals, assert } from "jsr:@std/assert";
// import * as fs from "jsr:@std/fs";
import { exists } from "jsr:@std/fs";
import * as yaml from "jsr:@std/yaml";
import * as toml from "jsr:@std/toml";

import * as path from "node:path";
import process from 'node:process';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { Buffer } from "node:buffer";
import os from 'node:os';
import fs from 'node:fs';


// UTILITIES

const ENV_VAR_REGISTRY: string = 'WASMER_REGISTRY';
const ENV_VAR_NAMESPACE: string = 'WASMER_NAMESPACE';
const ENV_VAR_TOKEN: string = 'WASMER_TOKEN';
const ENV_VAR_APP_DOMAIN: string = 'WASMER_APP_DOMAIN';
const ENV_VAR_EDGE_SERVER: string = 'EDGE_SERVER';
const ENV_VAR_WASMER_PATH: string = 'WASMER_PATH';
const ENV_VAR_WASMOPTICON_DIR: string = 'WASMOPTICON_DIR';

const REGISTRY_DEV: string = 'https://registry.wasmer.wtf/graphql';
const REGISTRY_PROD: string = 'https://registry.wasmer.io/graphql';

const appDomainMap = {
  [REGISTRY_PROD]: 'wasmer.app',
  [REGISTRY_DEV]: 'wasmer.dev',
};

const DEFAULT_NAMESPACE: string = 'wasmer-integration-tests';

async function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function randomAppName(): string {
  const id = crypto.randomUUID();
  return 't-' + id.replace(/\-/g, '').substr(0, 20);
}

// Path to the wasmopticon repo.
async function wasmopticonDir(): Promise<string> {
  const WASMOPTICON_GIT_URL = 'https://github.com/wasix-org/wasmopticon.git';
  let dir = process.env[ENV_VAR_WASMOPTICON_DIR];
  if (dir) {
    const doesExist = await exists(dir);
    if (!doesExist) {
      throw new Error(`${ENV_VAR_WASMOPTICON_DIR} is set, but directory does not exist: ${dir}`);
    }
    return dir;
  }

  // No env var set, check the default location.
  const localDir = path.join(process.cwd(), 'wasmopticon');

  // Acquire a lock to prevent multiple concurrent clones.
  const lockPath = path.join(process.cwd(), 'wasmopticon-clone.lock');
  while (true) {
    try {
      fs.promises.writeFile(lockPath, '', { flag: 'wx' });
      // Lock acquired, start cloning.
      break;
    } catch {
      // Lock already exists.
      // Wait a bit and try again.
      await sleep(1000);
    }
  }

  const freeLock = async () => {
    await fs.promises.unlink(lockPath);
  }

  // Lock acquired.
  if (await exists(localDir)) {
    await freeLock();
    return localDir;
  }

  console.log('wasmopticon dir not found')
  console.log(`Cloning ${WASMOPTICON_GIT_URL} to ${localDir}...`);

  const cmd = new Deno.Command('git', {
    args: ['clone', WASMOPTICON_GIT_URL, localDir],
  });
  const output = await cmd.output();
  await freeLock();
  if (!output.success) {
    throw new Error(`Failed to clone wasmopticon: ${output.code}`);
  }
  return localDir;
}

// The global wasmer config file.
interface WasmerConfig {
  registry?: {
    active_registry?: string,
    tokens?: [{ registry: string, token: string }]
  },
}

function loadWasmerConfig(): WasmerConfig {
  const p = path.join(os.homedir(), '.wasmer/wasmer.toml');
  const contents = fs.readFileSync(p, 'utf-8');
  const data = toml.parse(contents);
  return data;
}

// Custom node API based http client.
//
// Needed to allow custom dns resolution and accepting invalid certs.
class HttpClient {
  targetServer: string | null = null;

  async fetch(url: string, options: RequestInit): Promise<Response> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;

      const requestHeaders: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(options.headers ?? {})) {
        requestHeaders[key] = value;
      }

      let lookup: any = null;
      if (this.targetServer) {
        const ipProto = this.targetServer.includes(':') ? 6 : 4;
        lookup = (_hostname: string, _options: any, callback: any) => {
          callback(null, this.targetServer, ipProto);
          throw new Error('lookup called');
        };
      }

      const requestOptions = {
        method: options.method || 'GET',
        headers: requestHeaders,
        lookup,
      };

      const req = protocol.request(parsedUrl, requestOptions, (res) => {
        let data: any[] = [];

        res.on('data', (chunk) => {
          data.push(chunk);
        });

        res.on('end', () => {

          const plainHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (value) {
              if (typeof value === 'string') {
                plainHeaders[key] = value;
              } else {
                throw new Error(`could not convert header value: ${key}: ${typeof value}`);
              }
            }
          }

          const headers = new Headers(plainHeaders);

          const buffer = Buffer.concat(data);
          const status = res.statusCode || 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage ?? 'unknown',
            json: () => Promise.resolve(JSON.parse(buffer.toString())),
            text: () => Promise.resolve(buffer.toString()),
            bytes: () => Promise.resolve(buffer),
            arrayBuffer: () => Promise.resolve(buffer),
            headers,
            url: res.url ?? '',
            body: null,
            redirected: false,
            bodyUsed: true,
            clone: () => {
              throw new Error('Not implemented');
            },
            blob: () => {
              throw new Error('Not implemented');
            },
            formData: () => {
              throw new Error('Not implemented');
            },
            type: 'default',
          });
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }
}

type PackageIdent = string;

function parseDeployOutput(stdout: string, dir: Path): DeployOutput {
  let infoRaw: any;
  try {
    infoRaw = JSON.parse(stdout);

  } catch (err) {
    throw new Error(`Invalid output data: could not parse output as JSON: '${err}': '${stdout}'`);
  }

  let jsonConfig: any;
  try {
    jsonConfig = JSON.parse(infoRaw?.json_config);
  } catch (err) {
    throw new Error(`Invalid output data: could not parse JSON config: '${err}': '${infoRaw?.jsonConfig}'`);
  }

  const fullName = jsonConfig?.meta?.name;
  if (typeof fullName !== "string") {
    throw new Error(`Invalid output data: could not extract name from JSON config: '${infoRaw?.jsonConfig}'`);
  }
  const [_owner, name] = fullName.split('/');


  if (typeof infoRaw !== "object") {
    throw new Error(`Invalid output data: expected JSON object, got '${stdout}'`);
  }

  const versionId = infoRaw?.id;
  if (typeof versionId !== "string") {
    throw new Error(`Invalid output data: could not extract ID from '${stdout}'`);
  }

  const appId = infoRaw?.app?.id;
  if (typeof appId !== "string") {
    throw new Error(`Invalid output data: could not extract app ID from '${stdout}'`);
  }

  const url = infoRaw?.url;
  if (typeof url !== "string" || !url.startsWith("http")) {
    throw new Error(`Invalid output data: could not extract URL from '${stdout}'`);
  }

  const info: DeployOutput = {
    name,
    appId,
    appVersionId: versionId,
    url,
    path: dir,
  };

  return info
}

// Ensure that a NAMED package at a given path is published.
//
// Returns the package name.
async function ensurePackagePublished(env: TestEnv, dir: Path): Promise<PackageIdent> {
  const manifsetPath = path.join(dir, 'wasmer.toml');
  const manifestRaw = await fs.promises.readFile(manifsetPath, 'utf-8');

  let manifest: any;
  try {
    manifest = toml.parse(manifestRaw);
  } catch (err) {
    throw new Error(`Failed to parse package manifest at '${manifsetPath}': ${err}`);
  }

  const name = manifest?.package?.name;
  if (typeof name !== "string") {
    throw new Error(`Invalid package manifest: missing package name: ${manifestRaw}`);
  }
  const parts = name.split('/');
  if (parts.length !== 2) {
    throw new Error(`Invalid package name: expected 'owner/name', got '${name}'`);
  }

  const args = [
    "publish",
    "--bump",
    dir,
  ];

  console.debug(`Publishing package at '${dir}'...`);
  await env.runWasmerCommand({ args });

  return name;
}

interface AppFetchOptions extends RequestInit {
  // Ignore non-success status codes.
  noAssertSuccess?: boolean;
  // Discard the response body.
  discardBody?: boolean;
}

interface CommandOptions {
  args: string[];
  cwd?: Path;
  env?: Record<string, string>;
  stdin?: string;
  noAssertSuccess?: boolean;
}

interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

interface ApiDeployApp {
  id: string;
  url: string;
}

interface AppInfo {
  version: DeployOutput;
  app: ApiDeployApp;

  id: string;
  url: string;
  // Directory holding the app.
  dir: Path;
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: any[];
}

class BackendClient {
  url: string;
  token: string | null;

  constructor(url: string, token: string | null) {
    this.url = url;
    this.token = token;
  }

  // Send a GraphQL query to the backend.
  async gqlQuery(query: string, variables: Record<string, any> = {}): Promise<GraphQlResponse<any>> {
    const requestBody = JSON.stringify({
      query,
      variables,
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const res = await fetch(this.url, {
      method: 'POST',
      body: requestBody,
      headers,
    });

    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Failed to send GraphQL query: ${res.status}\nBODY:\n${body}`);
    }

    let response: GraphQlResponse<any>;
    try {
      response = JSON.parse(body);
    } catch (err) {
      throw new Error(`Failed to parse GraphQL JSON response: ${err}\nBODY:\n${body}`);
    }
    if (response.errors) {
      throw new Error(`GraphQL query failed: ${JSON.stringify(response.errors)}`);
    }
    if (!response.data) {
      throw new Error(`GraphQL query failed: no data returned`);
    }
    return response;
  }

  async getAppById(appId: string): Promise<ApiDeployApp> {
    const res = await this.gqlQuery(`
      query($id:ID!) {
        node(id:$id) {
          ... on DeployApp {
            id
            url
          }
        }
      }
    `, { id: appId });


    const node = res.data.node;
    if (!node) {
      console.debug({ res });
      throw new Error(`App not found: ${appId}`);
    }

    const id = node.id;
    assert(typeof id === 'string');

    const url = node.url;
    assert(typeof url === 'string');

    const app: ApiDeployApp = {
      id,
      url,
    };

    return app;
  }
}


interface DeployOptions {
  extraCliArgs?: string[];
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
  wasmerBinary: string = 'wasmer';

  httpClient: HttpClient;
  backend: BackendClient;

  static fromEnv(): TestEnv {
    const registry = process.env[ENV_VAR_REGISTRY] ?? REGISTRY_DEV;
    const namespace = process.env[ENV_VAR_NAMESPACE] ?? DEFAULT_NAMESPACE;

    const appDomainEnv = process.env[ENV_VAR_APP_DOMAIN];

    let appDomain;
    if (registry in appDomainMap) {
      appDomain = appDomainMap[registry];
    } else if (appDomainEnv) {
      appDomain = appDomainEnv;
    } else {
      throw new Error(
        `Could not determine the app domain for registry ${registry}:
	Set the ${ENV_VAR_APP_DOMAIN} env var!`
      );
    };

    const edgeServer = process.env[ENV_VAR_EDGE_SERVER];
    const wasmerBinary = process.env[ENV_VAR_WASMER_PATH];
    let maybeToken: string | null = process.env[ENV_VAR_TOKEN] ?? null;

    // If token is not set, try to read it from the wasmer config.
    // The token is needed for API requests.
    if (!maybeToken) {
      const config = loadWasmerConfig();
      maybeToken = config.registry?.tokens?.find((t) => t.registry === registry)?.token ?? null;
      if (!maybeToken) {
        throw new Error(
          `Could not find token for registry ${registry} in wasmer.toml config - \
            specify the token with the WASMER_TOKEN env var`
        );
      }
    }

    const token: string = maybeToken;

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

  private constructor(registry: string, token: string, namespace: string, appDomain: string, client: HttpClient) {
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
    if (!args.includes('--registry')) {
      env['WASMER_REGISTRY'] = this.registry;
    }
    if (!args.includes('--token')) {
      env['WASMER_TOKEN'] = this.token;
    }

    const copts: Deno.CommandOptions = {
      cwd: options.cwd,
      args,
      env,
      stdin: options.stdin ? 'piped' : 'null',
    };

    console.debug("Running command...", copts);
    const command = new Deno.Command(cmd,  {
      ...copts,
      stdout: 'piped',
      stderr: 'piped',
    });

    // create subprocess and collect output
    const proc = command.spawn();

    if (options.stdin) {
      const writer = proc.stdin.getWriter();
      writer.write(new TextEncoder().encode(options.stdin));
      writer.releaseLock();
      proc.stdin.close();
    }

    const output = await proc.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);

    const result: CommandOutput = {
      code: output.code,
      stdout,
      stderr,
    };

    console.debug("Command executed:", result);

    if (output.code !== 0 && options.noAssertSuccess !== true) {
      const data = JSON.stringify(result, null, 2);
      throw new Error(`Command failed: ${data}`);
    }

    return result;
  }

  async deployAppDir(dir: Path, options?: DeployOptions): Promise<AppInfo> {
    const extraArgs = options?.extraCliArgs ?? [];
    const noWait = options?.noWait ?? false;

    const args: string[] = [
      "deploy",
      "--format",
      "json",
      ...extraArgs,
    ];

    // If a specific server should be tested, don't wait for the deployment to
    // succeed, because the CLI might not test the specific server.
    if (noWait || this.edgeServer) {
      args.push('--no-wait');
    }

    const { code, stdout, stderr } = await this.runWasmerCommand({
      args,
      cwd: dir,
    });

    const version = parseDeployOutput(stdout, dir);
    const info = await this.resolveAppInfoFromVersion(version, dir);

    if (this.edgeServer && !noWait) {
      // Specific target server, but waiting is enabled, so manually test.
      const res = await this.fetchApp(info, '/');
    }

    console.debug('App deployed', { info });
    return info;
  }

  async resolveAppInfoFromVersion(version: DeployOutput, dir: Path): Promise<AppInfo> {
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

  async deployApp(spec: AppDefinition, options?: DeployOptions): Promise<AppInfo> {
    // Stub in values.
    if (!spec.appYaml.owner) {
      spec.appYaml.owner = this.namespace;
    }
    if (!spec.appYaml.name) {
      spec.appYaml.name = randomAppName();
    }
    if (!spec.appYaml.domains) {
      spec.appYaml.domains = [spec.appYaml.name + '.' + this.appDomain];
    }

    const dir = await buildTempDir(spec.files ?? {});
    await writeAppDefinition(dir, spec);
    return this.deployAppDir(dir, options);
  }

  async deleteApp(app: AppInfo): Promise<void> {
    await this.runWasmerCommand({
      args: ['app', 'delete', app.id],
    });
  }

  async fetchApp(app: AppInfo, urlOrPath: string, options: AppFetchOptions = {}): Promise<Response> {
    let url: string;
    if (urlOrPath.startsWith('http')) {
      url = urlOrPath;
    } else {
      url = app.url + (urlOrPath.startsWith('/') ? '' : '/') + urlOrPath;
    }

    // Should not follow redirects by default.
    if (!options.redirect) {
      options.redirect = 'manual';
    }

    console.debug(`Fetching URL ${url}`, { options });
    const response = await this.httpClient.fetch(url, options);
    console.debug(`Fetched URL ${url}`, { status: response.status, headers: response.headers });
    // if (options.discardBody) {
    //   await response.body?.cancel();
    // }
    if (!options.noAssertSuccess && !response.ok) {
      // Try to get the body:
      let body: string | null = null;
      try {
        body = await response.text();
      } catch (err) { }

      // TODO: allow running against a particular server.
      throw new Error(`Failed to fetch URL '${url}': ${response.status}\n\nBODY:\n${body}`);
    }
    return response;
  }
}

const HEADER_PURGE_INSTANCES: string = 'x-edge-purge-instances';
const HEADER_INSTANCE_ID: string = 'x-edge-instance-id';

type Path = string;

interface DirEntry extends Record<Path, string | DirEntry> { };

// Build a file system directory from the provided directory tree.
async function buildDir(path: Path, files: DirEntry): Promise<void> {
  for (const [name, value] of Object.entries(files)) {
    const subPath = `${path}/${name}`;
    if (typeof value === "string") {
      await fs.promises.writeFile(subPath, value);
    } else {
      await fs.promises.mkdir(subPath, { recursive: true });
      await buildDir(subPath, value);
    }
  }
}

async function createTempDir(): Promise<Path> {
  const dir = path.join(os.tmpdir(), crypto.randomUUID());
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

// Build a temporary directory from the provided directory tree.
async function buildTempDir(files: DirEntry): Promise<Path> {
  const tempDir = await createTempDir();
  await buildDir(tempDir, files);
  return tempDir;
}

// Definition for an app.
// Contains an optional package definition, directory tree and app.yaml configuration.
interface AppDefinition {
  wasmerToml?: Record<string, any>,
  appYaml: Record<string, any>,
  files?: DirEntry,
}

// Build a basic static site `AppDefinition`.
//
// You can tweak the defintion by modifying the files if required.
function buildStaticSiteApp(): AppDefinition & { files: { "public": { "index.html": string } } } {
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
      kind: 'wasmer.io/App.v0',
      name: randomAppName(),
      package: '.',
    },
    files: {
      'public': {
        'index.html': `<html><body>Hello!</body></html>`,
      },
    }
  };
}

// Build a basic javascript worker `AppDefinition`.
//
// You can tweak the defintion by modifying the files if required.
function buildJsWorkerApp(jsCode?: string): AppDefinition & { files: { "src": { "index.js": string } } } {
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
            'main-args': ["/src/index.js"],
          }
        }
      }],
    },
    appYaml: {
      kind: 'wasmer.io/App.v0',
      name: randomAppName(),
      package: '.',
    },
    files: {
      'src': {
        'index.js': code
      },
    }
  };
}

// Write an `AppDefinition` to a directory.
async function writeAppDefinition(path: Path, app: AppDefinition) {
  const files: DirEntry = {
    ...(app.files ?? {}),
    'app.yaml': yaml.stringify(app.appYaml),
  };
  if (app.wasmerToml) {
    files['wasmer.toml'] = toml.stringify(app.wasmerToml);
  }

  console.debug(`Writing app definition to ${path}`, { files });
  await buildDir(path, files);
}

// Parsed output from the "wasmer deploy" command.
interface DeployOutput {
  name: string;
  appId: string;
  appVersionId: string;
  url: string;

  path: Path;
}

// TESTS

// Test that the instance purge header works correctly.
Deno.test("app-purge-instances", async () => {
  const spec = buildStaticSiteApp();

  // Enable debug mode to allow for instance ID and instance purging.
  spec.appYaml.debug = true;

  const env = TestEnv.fromEnv();
  const info = await env.deployApp(spec);

  const res = await env.fetchApp(info, '/');
  const instanceId1 = res.headers.get(HEADER_INSTANCE_ID);
  if (!instanceId1) {
    throw new Error(`Expected header ${HEADER_INSTANCE_ID} to be set in response`);
  }

  const body1 = await res.text();
  assertEquals(body1, '<html><body>Hello!</body></html>');

  const res2 = await env.fetchApp(info, '/');
  const instanceId2 = res2.headers.get(HEADER_INSTANCE_ID);
  if (!instanceId2) {
    throw new Error(`Expected header ${HEADER_INSTANCE_ID} to be set in response`);
  }
  assertEquals(instanceId1, instanceId2);
  await res2.body?.cancel();

  console.info('App deployed, purging instances...');

  // Purge the instance with the purge header.

  const res3 = await env.fetchApp(info, '/', {
    headers: {
      [HEADER_PURGE_INSTANCES]: '1',
    }
  });
  await res3.body?.cancel();

  const instanceId3 = res3.headers.get(HEADER_INSTANCE_ID);
  if (!instanceId3) {
    throw new Error(`Expected header ${HEADER_INSTANCE_ID} to be set in response`);
  }
  assertNotEquals(instanceId1, instanceId3);

  // Now the instance should stay the same again.

  const res4 = await env.fetchApp(info, '/');
  await res4.body?.cancel();
  const instanceId4 = res4.headers.get(HEADER_INSTANCE_ID);
  if (!instanceId4) {
    throw new Error(`Expected header ${HEADER_INSTANCE_ID} to be set in response`);
  }
  assertEquals(instanceId3, instanceId4);
});

// Test app auto https redirect functionality.
Deno.test("app-https-redirect", async () => {
  const spec = buildStaticSiteApp();
  spec.appYaml.name = randomAppName();
  // Note: redirects are enabled by default!
  // spec.appYaml.redirect = { force_https: true };

  const env = TestEnv.fromEnv();
  const info = await env.deployApp(spec);

  const res = await env.fetchApp(
    info,
    info.url.replace('https://', 'http://'),
    { noAssertSuccess: true }
  );
  await res.body?.cancel();
  assertEquals(res.status, 308);
  assertEquals(res.headers.get('location')?.replace(/\/$/, ''), info.url);

  // Now redeploy the app with https redirect disabled.

  console.info('Re-deploying app with https redirect disabled...')

  spec.appYaml.redirect = { force_https: false };
  writeAppDefinition(info.dir, spec);
  const info2 = await env.deployAppDir(info.dir);

  const res2 = await env.fetchApp(
    info2,
    info2.url.replace('https://', 'http://'),
  );
  await res2.body?.cancel();
  assertEquals(res2.status, 200);
});

Deno.test('app-volumes', async () => {
  const env = TestEnv.fromEnv();

  const phpServerDir = path.join(await wasmopticonDir(), 'php/php-testserver');
  const phpServerPackage = await ensurePackagePublished(env, phpServerDir);

  const app: AppDefinition = {
    appYaml: {
      kind: 'wasmer.io/App.v0',
      package: phpServerPackage,
      // Enable debug mode to allow instance purging.
      debug: true,
      volumes: [
        {
          name: 'data',
          mount: '/data',
        }
      ],
    },
  };
  const info = await env.deployApp(app);

  const file1Content = 'value1';

  // Write a file to the volume.
  await env.fetchApp(info, '/fs/write/data/file1', {
    method: 'POST',
    body: file1Content,
    discardBody: true,
  });

  // Read the file.
  {
    const resp = await env.fetchApp(info, '/fs/read/data/file1');
    const body = await resp.text();
    assertEquals(body, file1Content);
  }


  // Now read again, but force a fresh instance to make sure it wasn't just
  // stored in memory.
  {
    const resp = await env.fetchApp(info, '/fs/read/data/file1', {
      headers: {
        [HEADER_PURGE_INSTANCES]: '1',
      }
    });
    const body = await resp.text();
    assertEquals(body, file1Content);
  }
});

// TODO: fix CGI!
Deno.test.ignore('app-python-wcgi', async () => {
  const env = TestEnv.fromEnv();

  const spec: AppDefinition = {
    wasmerToml: {
      dependencies: {
        "wasmer/python": "*",
      },
      fs: {
        "/src": "src",
      },
      command: [{
        name: "script",
        module: "wasmer/python:python",
        runner: "https://webc.org/runner/wcgi",
        annotations: {
          wasi: {
            'main-args': ["/src/main.py"],
          }
        }
      }],
    },
    appYaml: {
      kind: 'wasmer.io/App.v0',
      package: '.',
    },
    files: {
      'src': {
        'main.py': `
print("HTTP/1.1 200 OK\r")
print("Content-Type: text/html\r")
print("\r")
print("<html><body><h1>Hello, World!</h1></body></html>\r")
print("\r")
        `,
      },
    },
  };

  const info = await env.deployApp(spec);

  const res = await env.fetchApp(info, '/');
  const body = await res.text();
  assertEquals(body.trim(), '<html><body><h1>Hello, World!</h1></body></html>');
});

Deno.test('app-winterjs', async () => {
  const env = TestEnv.fromEnv();

  const spec: AppDefinition = {
    wasmerToml: {
      dependencies: {
        "wasmer/winterjs": "*",
      },
      fs: {
        "/src": "src",
      },
      command: [{
        name: "script",
        module: "wasmer/winterjs:winterjs",
        runner: "https://webc.org/runner/wasi",
        annotations: {
          wasi: {
            'main-args': ["/src/main.js"],
          }
        }
      }],
    },
    appYaml: {
      kind: 'wasmer.io/App.v0',
      package: '.',
    },
    files: {
      'src': {
        'main.js': `
addEventListener('fetch', (req) => {
    req.respondWith(new Response('Hello World!'));
});
        `
      },
    }
  };

  const info = await env.deployApp(spec);
  const res = await env.fetchApp(info, '/');
  const body = await res.text();

  assertEquals(body, 'Hello World!');

});

Deno.test('app-php', async () => {
  const env = TestEnv.fromEnv();

  const spec: AppDefinition = {
    wasmerToml: {
      dependencies: {
        "php/php": "8.*",
      },
      fs: {
        "/src": "src",
      },
      command: [{
        name: "run",
        module: "php/php:php",
        runner: "wasi",
        annotations: {
          wasi: {
            'main-args': ["-t", "/src", "-S", "localhost:8080"],
          }
        }
      }],
    },
    appYaml: {
      kind: 'wasmer.io/App.v0',
      package: '.',
    },
    files: {
      'src': {
        'index.php': `
<?php
echo $_GET["name"];
        `,
      },
    },
  };

  const info = await env.deployApp(spec);
  const res = await env.fetchApp(info, '/?name=world');
  const body = await res.text();
  assertEquals(body.trim(), 'world');
});

Deno.test('app-rust-axum', async () => {
  const env = TestEnv.fromEnv();

  const spec: AppDefinition = {
    appYaml: {
      kind: 'wasmer.io/App.v0',
      package: 'wasmer-integration-tests/axum',
    },
  };

  const info = await env.deployApp(spec);
  const res = await env.fetchApp(info, '/?name=world');
  const body = await res.text();
  assertEquals(body.trim(), '{"name": "world"}');
});

Deno.test('recreate-app-with-same-name', async () => {
  const env = TestEnv.fromEnv();
  const spec = buildStaticSiteApp()
  spec.files!.public['index.html'] = 'version ALPHA';
  const info = await env.deployApp(spec);
  const res = await env.fetchApp(info, '/');
  const body = await res.text();
  assertEquals(body, 'version ALPHA');

  console.log('Deleting app', { info });
  await env.deleteApp(info);

  console.log('Sleeping...')
  sleep(5_000);

  // Now deploy the app again with the same name but different content.
  spec.files!.public['index.html'] = 'version BETA';
  const info2 = await env.deployApp(spec);
  const res2 = await env.fetchApp(info2, '/');
  const body2 = await res2.text();
  assertEquals(body2, 'version BETA');
});

Deno.test('app-listing', async () => {
  const env = TestEnv.fromEnv();
  const spec = buildStaticSiteApp();
  const info = await env.deployApp(spec);

  console.log('Test app deployed, retrieving app listing...');

  const listing = await env.runWasmerCommand({
    args: [
      "app",
      "list",
      "--namespace",
      env.namespace,
      "--format",
      "json",
      "--sort",
      "newest",
    ],
  });

  console.log('App listing loaded, searching for test app in listing...');

  const apps = JSON.parse(listing.stdout);

  const foundApp = apps.find((app: any) => app.name === info.version.name);

  if (!foundApp) {
    throw new Error(`App not found in listing: ${info.version.name}`);
  }
  console.log('App found in listing:', { app: foundApp });
});


// Create an app, delete it again and ensure that the app is not accessible
// anymore.
//
// TODO: ignored because app deletion seems to be problematic ATM
Deno.test.ignore('app-delete', async () => {
  const env = TestEnv.fromEnv();
  const spec = buildStaticSiteApp();
  const domain = spec.appYaml!.name + '.' + env.appDomain;
  spec.appYaml.domains = [domain];
  const info = await env.deployApp(spec);

  console.log('Delete app...');

  const listing = await env.runWasmerCommand({
    args: [
      'app',
      'delete',
    ],
    cwd: info.dir,
  });

  console.log('App deleted, waiting for app to become inaccessible...');

  const start = Date.now();

  const url = `https://${domain}/`;

  while (true) {
    const res = await env.fetchApp(info, url, { noAssertSuccess: true });
    if (res.status === 400) {
      console.log('App is no longer accessible');
      break
    } else {
      console.log('App still accessible ... waiting ...');
      const elapsed = Date.now() - start;
      if (elapsed > 60_000) {
        throw new Error('App is still accessible after 60 seconds');
      }
      await sleep(10_000);
    }
  }
});

Deno.test('app-info-get', async () => {
  const env = TestEnv.fromEnv();
  const spec = buildStaticSiteApp();
  const info = await env.deployApp(spec);

  // Test "app info"
  const output = await env.runWasmerCommand({
    args: ['app', 'info'],
    cwd: info.dir,
  });

  const appDomain = env.appDomain;
  const expectedUrl = `https://${info.version.name}.${env.appDomain}`;

  const stdout = output.stdout;

  assert(stdout.includes(`Name: ${info.version.name}`));
  assert(stdout.includes(`URL: ${expectedUrl}`));

  // Test "app get"
  const output2 = await env.runWasmerCommand({
    args: ['app', 'get', '--format', 'json'],
    cwd: info.dir,
  });

  const json = JSON.parse(output2.stdout);
  assertEquals(json.name, info.version.name);
  assertEquals(json.url, expectedUrl);
});

Deno.test('app-create-from-package', async () => {
  const env = TestEnv.fromEnv();
  const name = randomAppName();
  const fullName = `${env.namespace}/${name}`;

  const spec = buildStaticSiteApp();
  const pkgSpec = spec.wasmerToml!;
  pkgSpec.package = { name: `${env.namespace}/${name}`, version: '0.1.0' };

  console.log('Publishing package...');

  const pkgDir = await buildTempDir({
    'wasmer.toml': `
[package]
name = "${fullName}"
version = "0.1.0"

[dependencies]
"wasmer/static-web-server" = "1"

[fs]
"/public" = "public"

[[command]]
name = "script"
module = "wasmer/static-web-server:webserver"
runner = "https://webc.org/runner/wasi"
    `,
    'public': {
      'index.html': name,
    },
  });

  await env.runWasmerCommand({
    args: ['publish'],
    cwd: pkgDir
  });

  const appDir = await createTempDir();

  const output = await env.runWasmerCommand({
    args: [
      "app",
      "create",
      "--name",
      name,
      "--owner",
      env.namespace,
      "--package",
      fullName,
      "--deploy",
      '--format',
      'json',
    ],
    cwd: appDir,
  });
  const version = parseDeployOutput(output.stdout, pkgDir);
  const info = await env.resolveAppInfoFromVersion(version, pkgDir);

  const res = await env.fetchApp(info, '/');
  const body = await res.text();
  assertEquals(body.trim(), name);
});

Deno.test('app-update-multiple-times', async () => {
  const env = TestEnv.fromEnv();
  const spec = buildStaticSiteApp();
  const info1 = await env.deployApp(spec);

  const indexPath = path.join(info1.dir, 'public/index.html');

  for (let i = 0; i < 3; i++) {
    const content = `hello-${i}`;
    await fs.promises.writeFile(indexPath, content);
    await env.deployAppDir(info1.dir);

    const res = await env.fetchApp(info1, '/');
    const body = await res.text();
    assertEquals(body.trim(), content);
  }
});

Deno.test('app-logs', async () => {
  const env = TestEnv.fromEnv();
  const code = `

addEventListener("fetch", (fetchEvent) => {
  console.log('hello logs')
  fetchEvent.respondWith(new Response('ok'));
});

  `
  const spec = buildJsWorkerApp(code);
  const info = await env.deployApp(spec);

  const start = Date.now();
  while (true) {
    const output = await env.runWasmerCommand({
      args: ['app', 'logs'],
      cwd: info.dir,
    });

    if (output.stdout.includes('hello logs')) {
      console.log('Logs found in output');
      break;
    } else {
      const elapsed = Date.now() - start;
      if (elapsed > 60_000) {
        throw new Error('Logs not found after 60 seconds');
      }
    }
  }
});

const EDGE_HEADER_PURGE_INSTANCES = 'x-edge-purge-instances';
const EDGE_HEADER_JOURNAL_STATUS = 'x-edge-instance-journal-status';

function buildPhpInstabootTimestampApp(): AppDefinition {

  const phpCode = `
<?php

error_reporting(E_ALL);
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');

function router() {
  $timestamp_path = '/tmp/timestamp.txt';
  $header_instaboot = 'HTTP_X_EDGE_INSTABOOT';

  // if instaboot header is set, create timestamp file
  if (isset($_SERVER[$header_instaboot])) {
    $timestamp = time();
    file_put_contents($timestamp_path, $timestamp);
  } else {
    // if timestamp file exists, return timestamp
    if (file_exists($timestamp_path)) {
      $timestamp = file_get_contents($timestamp_path);
      echo $timestamp;
    } else {
      echo 'NO_TIMESTAMP';
    }
  }
}

router();
        `;


  const spec: AppDefinition = {
    wasmerToml: {
      dependencies: {
        "php/php": "8.3.*",
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
            'main-args': ["-S", "localhost:8080", "/src/index.php"],
          }
        }
      }],
    },
    appYaml: {
      kind: 'wasmer.io/App.v0',
      name: randomAppName(),
      package: '.',
      debug: true,
      capabilities: {
        instaboot: {
          requests: [
            { path: '/' }
          ]
        },
      }
    },
    files: {
      'src': {
        'index.php': phpCode
      },
    }
  };

  return spec;
}

/// Instaboot cache purge test.
///
/// Uses a PHP app that creates a timestamp file during instaboot, and
/// then returns that timestamp value in responses.
Deno.test('app-cache-purge-instaboot-php', async () => {
  const env = TestEnv.fromEnv();

  const spec = buildPhpInstabootTimestampApp();

  // Deploy the app, but specify noWait to prevent the CLI from doing a first
  // request. That would mess with the later validation.
  const info = await env.deployApp(spec, { noWait: true });


  // The first request should not have a journal yet, so no timestamp should
  // be returned.
  {
    const res = await env.fetchApp(info, '/', {
      headers: {},
    });
    const body = await res.text();

    // No journal should have been created yet, so the status should be "none".
    assertEquals(res.headers.get(EDGE_HEADER_JOURNAL_STATUS), 'none');
    assertEquals(body.trim(), 'NO_TIMESTAMP');
  }

  // Now do a new request that should be served from a journal.
  // Must provide the purge header to ensure a new instance is created, otherwise
  // the old instance started without a journal would still  be active.
  {
    const res = await env.fetchApp(info, '/', {
      headers: {
        [EDGE_HEADER_PURGE_INSTANCES]: '1',
      },
    });
    const body = await res.text();

    // No journal should have been created yet, so the status should be "none".
    assertEquals(res.headers.get(EDGE_HEADER_JOURNAL_STATUS), 'bootsrap=journal+memory');
    // Body should be a timestamp.
    try {

      parseInt(body);
    } catch (err) {
      throw new Error(`Expected body to be a timestamp, got: ${body}`);
    }
  }

});

/// Instaboot max_age test.
///
/// Ensures that the max_age config option is respected by Edge.
///
/// Uses a PHP app that creates a timestamp file during instaboot, and
/// then returns that timestamp value in responses.
///
Deno.test('instaboot-max-age', async () => {
  const env = TestEnv.fromEnv();
  const spec = buildPhpInstabootTimestampApp();
  spec.appYaml.capabilities.instaboot.max_age = '5s';

  // No-wait to prevent the CLI from doing a first request which initialises
  // the timestamp.
  const info = await env.deployApp(spec, { noWait: true });

  const fetchApp = () => env.fetchApp(info, '/', {
    headers: {
      [EDGE_HEADER_PURGE_INSTANCES]: '1',
    },
  });

  // First request - should be NO_TIMESTAMP
  {
    const res = await fetchApp();
    const body = await res.text();
    assertEquals(body.trim(), 'NO_TIMESTAMP');
    assertEquals(res.headers.get(EDGE_HEADER_JOURNAL_STATUS), 'none');
  }

  // Second request - should be a timestamp
  let initialTimestamp: number;
  {
    const res = await fetchApp();
    const body = await res.text();
    assertEquals(res.headers.get(EDGE_HEADER_JOURNAL_STATUS), 'bootsrap=journal+memory');
    try {
      initialTimestamp = parseInt(body);
    } catch (err) {
      throw new Error(`Expected body to be a timestamp, got: ${body}`);
    }
  }

  const expireTime = initialTimestamp + 5_500;

  // Now wait for the max_age to expire.
  console.log('Sleeping to wait for old journal to expire...');
  await sleep(6_000);

  // Request to trigger re-creation of the journal
  {
    await fetchApp();
    await fetchApp();
  }

  // Now the timestamp should be different.
  {
    const res = await fetchApp();
    const body = await res.text();
    assertEquals(res.headers.get(EDGE_HEADER_JOURNAL_STATUS), 'bootsrap=journal+memory');
    let newTimestamp: number;
    try {
      newTimestamp = parseInt(body);
    } catch (err) {
      throw new Error(`Expected body to be a timestamp, got: "${body}"`);
    }

    console.log('Validating old vs new timestamp', { initialTimestamp, newTimestamp });
    assert(newTimestamp > initialTimestamp);
  }
});

Deno.test('dns-zonefile', async () => {
  const env = TestEnv.fromEnv();
  const tmpDir = await createTempDir();

  const id = crypto.randomUUID().replace(/-/g, '');
  const domain = `${id}.com`;

  // Register the domain.
  await env.runWasmerCommand({
    args: ['domain', 'register', domain],
  });

  // Get the zone file, just to make sure it works.
  const output = await env.runWasmerCommand({
    args: ['domain', 'get-zone-file', domain],
  });
  let zoneFile = output.stdout;
  zoneFile += "$TTL 3600\nsub IN A 127.0.0.1";

  const subdomain = `sub.${domain}`;

  const zoneFilePath = path.join(tmpDir, 'zonefile');
  await fs.promises.writeFile(zoneFilePath, zoneFile);

  // Sync the zone file.
  await env.runWasmerCommand({
    args: ['domain', 'sync-zone-file', zoneFilePath],
  });


  // Resolve a server in the cluster.
  console.log('Resolving Edge DNS server ip...')
  const aRecords = await Deno.resolveDns(env.appDomain, 'A');
  if (aRecords.length === 0) {
    throw new Error(`No DNS A records found for ${env.appDomain}`);
  }
  const dnsServerIp = aRecords[0];
  console.log('Resolved Edge DNS server ip: ' + dnsServerIp);

  // Resolve the custom domain.

  const start = Date.now();
  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed > 60_000) {
      throw new Error('Timeout while waiting for DNS records to become available');
    }

    console.log('Resolving custom domain', { subdomain, dnsServerIp })
    let domainRecords;
    try {
      domainRecords = await Deno.resolveDns(subdomain.trim(), "A", {
        nameServer: { ipAddr: dnsServerIp, port: 53 },
      });
    } catch (error) {
      console.error('Error while resolving DNS records ... retrying ...', { error });
      await sleep(3_000);
      continue;
    }

    console.log('Resolved', { domainRecords });
    const isMatch = domainRecords.length === 1 && domainRecords[0] === "127.0.0.1";
    if (isMatch) {
      break;
    } else {
      console.log('DNS records do not match yet, waiting...', { domainRecords });
      await sleep(3_000);
    }
  }
});

Deno.test('package-download-named', async () => {
  const env = TestEnv.fromEnv();

  const name = randomAppName();
  const fullName = `${env.namespace}/${name}`;

  const wasmerToml = toml.stringify({
    package: {
      name: fullName,
      version: '0.0.1',
    },
    fs: {
      'data': './data',
    },
  });
  const files = {
    'wasmer.toml': wasmerToml,
    data: {
      'a.txt': 'a',
      'b': {
        'b.txt': 'b',
      },
    }
  };
  const dir = await buildTempDir(files);

  // Publish the package.
  await env.runWasmerCommand({
    args: ['publish'],
    cwd: dir,
  });

  // Download again.
  const webcPath = path.join(dir, 'dl.webc');
  await env.runWasmerCommand({
    args: ['package', 'download', fullName, '-o', webcPath],
  });

  const unpackDir = path.join(dir, 'unpacked');
  await env.runWasmerCommand({
    args: ['package', 'unpack', webcPath, '-o', unpackDir],
  });

  const dataDir = path.join(unpackDir, 'data');

  assertEquals(
    await fs.promises.readFile(path.join(dataDir, 'a.txt'), 'utf-8'),
    'a'
  );
  assertEquals(
    await fs.promises.readFile(path.join(dataDir, 'b/b.txt'), 'utf-8'),
    'b'
  );
});

Deno.test('package-download-unnamed', async () => {
  const env = TestEnv.fromEnv();

  const name = randomAppName();
  const fullName = `${env.namespace}/${name}`;

  const wasmerToml = toml.stringify({
    fs: {
      'data': './data',
    },
  });
  const files = {
    'wasmer.toml': wasmerToml,
    data: {
      'a.txt': 'a',
      'b': {
        'b.txt': 'b',
      },
    }
  };
  const dir = await buildTempDir(files);

  // Upload the package.
  const output = await env.runWasmerCommand({
    args: ['package', 'push', '--namespace', env.namespace],
    cwd: dir,
  });

  // Parse the hash from the output.
  const out = output.stderr;
  console.log('Parsing output: ' + out)
  const hash = out.split('sha256:')[1].substring(0, 64);
  if (hash.length !== 64) {
    throw new Error(`Hash not found in output: ${out}`);
  }

  // Download
  const webcPath = path.join(dir, 'out.webc');
  await env.runWasmerCommand({
    args: ['package', 'download', `sha256:${hash}`, '-o', webcPath],
  });

  // Unpack
  const unpackDir = path.join(dir, 'unpacked');
  await env.runWasmerCommand({
    args: ['package', 'unpack', webcPath, '-o', unpackDir],
  });

  const dataDir = path.join(unpackDir, 'data');
  assertEquals(
    await fs.promises.readFile(path.join(dataDir, 'a.txt'), 'utf-8'),
    'a'
  );
  assertEquals(
    await fs.promises.readFile(path.join(dataDir, 'b/b.txt'), 'utf-8'),
    'b'
  );
});


// async fn test_publish() {
//     let dir = TempDir::new().unwrap().into_path();
//     // registry requires package names to start with non number
//     let name = format!("a{}", Uuid::new_v4().to_string());
//     write(
//         dir.join("wasmer.toml"),
//         format!(
//             r#"
// [package]
// name = "wasmer-integration-tests/{name}"
// version = "0.1.0"
// [dependencies]
// "wasmer/python" = "3"
//     "#
//         ),
//     )
//     .unwrap();
//
//     assert!(Command::new("wasmer")
//         .args(["publish"])
//         .current_dir(&dir)
//         .status()
//         .unwrap()
//         .success());
//     let output = String::from_utf8(
//         Command::new("wasmer")
//             .args([
//                 "run",
//                 &format!("wasmer-integration-tests/{name}"),
//                 "--",
//                 "-c",
//                 "print('Hello World!')",
//             ])
//             .current_dir(dir)
//             .output()
//             .unwrap()
//             .stdout,
//     )
//     .unwrap();
//     assert!(output.contains("Hello World!"), "output={output}");
// }

Deno.test('package-publish-and-run', async () => {
  const env = TestEnv.fromEnv();
  const name = randomAppName();
  const fullName = `${env.namespace}/${name}`;

  const wasmerToml = toml.stringify({
    package: {
      name: fullName,
      version: '0.0.1',
    },
    dependencies: {
      "wasmer/python": "3",
    },
    fs: {
      'src': './src',
    },
    command: [{
      name: 'script',
      module: 'wasmer/python:python',
      runner: 'https://webc.org/runner/wasi',
      annotations: {
        wasi: {
          'main-args': ['/src/main.py'],
        },
      },
    }],
  });

  const files = {
    'wasmer.toml': wasmerToml,
    src: {
      'main.py': `print("${fullName}")`,
    },
  };

  const dir = await buildTempDir(files);

  await env.runWasmerCommand({
    args: ['publish'],
    cwd: dir,
  });

  console.log('Running package...');
  const output = await env.runWasmerCommand({
    args: ['run', fullName],
  });

  console.log(`Output: "${output.stdout}"`);

  assertEquals(output.stdout.trim(), fullName);
});

Deno.test('cli-run-python', async () => {
  const env = TestEnv.fromEnv();
  const output = await env.runWasmerCommand({
    args: ['run', 'wasmer/python', '--', '-c', 'print(40 + 2)'],
  });

  assertEquals(output.stdout.trim(), '42');
});

Deno.test('app-secrets-fullstack', async () => {
  const env = TestEnv.fromEnv();
  const code = `
addEventListener("fetch", (fetchEvent) => {
  fetchEvent.respondWith(new Response(JSON.stringify({
    env: process.env,
  })));
});
  `;
  const spec = buildJsWorkerApp(code);

  const info = await env.deployApp(spec, { noWait: true });

  // Create secrets.

  await env.runWasmerCommand({
    args: ['app', 'secret', 'create', '--app', info.id, 's1', 'v1'],
  });
  {
    const output = await env.runWasmerCommand({
      args: ['app', 'secret', 'reveal', '--app', info.id, 's1'],
    });
    assertEquals(output.stdout.trim(), 'v1');
  }


  await env.runWasmerCommand({
    args: ['app', 'secret', 'create', '--app', info.id, 's2', 'v2'],
  });
  {
    const output = await env.runWasmerCommand({
      args: ['app', 'secret', 'reveal', '--app', info.id, 's2'],
    });
    assertEquals(output.stdout.trim(), 'v2');
  }


  // make sure long secrets work.
  const valueLong = 'x'.repeat(10240);
  await env.runWasmerCommand({
    args: ['app', 'secret', 'create', '--app', info.id, 'slong', valueLong],
  });
  {
    const output = await env.runWasmerCommand({
      args: ['app', 'secret', 'reveal', '--app', info.id, 'slong'],
    });
    assertEquals(output.stdout.trim(), valueLong);
  }

  // Listing works
  {
    const output = await env.runWasmerCommand({
      args: ['app', 'secret', 'list', '--app', info.id],
    });

    const lines = output.stdout.trim().split('\n').map((line) => line.trim().split(' ')[0]);
    console.log('Retrieved secrets list', { lines });
    assert(lines.includes('s1'));
    assert(lines.includes('s2'));
    assert(lines.includes('slong'));
  }

  // Redeploy app to apply secrets.
  await env.deployAppDir(info.dir);

  // Fetch the app and check the response.
  {
    const res = await env.fetchApp(info, '/');
    const body = await res.text();
    const data = JSON.parse(body);
    console.log('Retrieved app response', { data })
    assertEquals(data.env['s1'], 'v1');
    assertEquals(data.env['s2'], 'v2');
    assertEquals(data.env['slong'], valueLong);
  }

  // Update a secret value.

  await env.runWasmerCommand({
    args: ['app', 'secret', 'update', '--app', info.id, 's1', 'v1-updated'],
  });
  {
    const output = await env.runWasmerCommand({
      args: ['app', 'secret', 'reveal', '--app', info.id, 's1'],
    });
    assertEquals(output.stdout.trim(), 'v1-updated');
  }

  // Deploy again to apply the updated secret.
  await env.deployAppDir(info.dir);

  // Check response.
  {
    const res = await env.fetchApp(info, '/');
    const body = await res.text();
    const data = JSON.parse(body);
    console.log('Retrieved app response', { data })
    assertEquals(data.env['s1'], 'v1-updated');
    assertEquals(data.env['s2'], 'v2');
    assertEquals(data.env['slong'], valueLong);
  }

  // Delete a secret.

  await env.runWasmerCommand({
    args: ['app', 'secret', 'delete', '--app', info.id, 's1'],
  });

  // Listing should not have the secret anymore 
  {
    const output = await env.runWasmerCommand({
      args: ['app', 'secret', 'list', '--app', info.id],
    });
    const lines = output.stdout.trim().split('\n').map((line) => line.trim().split(' ')[0]);
    assert(!lines.includes('s1'));
  }

  // Deploy again.
  await env.deployAppDir(info.dir);

  // Check response.
  {
    const res = await env.fetchApp(info, '/');
    const body = await res.text();
    const data = JSON.parse(body);
    console.log('Retrieved app response', { data })
    assertEquals(data.env['s2'], 'v2');
    assertEquals(data.env['slong'], valueLong);
    assertEquals(data.env['s1'], undefined);
  }
});

Deno.test('deploy-fails-without-app-name', async () => {
  const env = TestEnv.fromEnv();

  const spec = buildStaticSiteApp();
  spec.appYaml.owner = env.namespace;
  delete spec.appYaml.name;

  const dir = await createTempDir();
  await writeAppDefinition(dir, spec);

  try {
    await env.deployAppDir(dir, { noWait: true });
  } catch (err) {
    console.log('Deploy failed with error: ' + err);
    assert(err.toString().includes('does not specify any app name'));
    return
  }

  throw new Error('Expected deploy to fail without app name');
});


Deno.test('deploy-fails-without-owner', async () => {
  const env = TestEnv.fromEnv();

  const spec = buildStaticSiteApp();

  const dir = await createTempDir();
  await writeAppDefinition(dir, spec);

  try {
    await env.deployAppDir(dir, { noWait: true });
  } catch (err) {
    console.log('Deploy failed with error: ' + err);
    assert(err.toString().includes('No owner specified'));
    return
  }

  throw new Error('Expected deploy to fail without app name');
});

// #[test_log::test(tokio::test)]
// async fn test_ssh() {
//     assert!(String::from_utf8(
//         Command::new("wasmer")
//             .args(["ssh", "sharrattj/bash", "--", "-c", "ls"])
//             .output()
//             .unwrap()
//             .stdout
//     )
//     .unwrap()
//     .trim()
//     .split_ascii_whitespace()
//     .any(|e| e == "bin"));
//     assert_eq!(
//         "/test",
//         String::from_utf8(
//             Command::new("sh")
//                 .args(["-c", "echo 'mkdir test && cd test && pwd' | wasmer ssh"])
//                 .output()
//                 .unwrap()
//                 .stdout
//         )
//         .unwrap()
//         .trim()
//     );
//     assert_eq!(
//         "hello",
//         String::from_utf8(
//             Command::new("sh")
//                 .args(["-c", "echo 'echo -n hello > test && cat test' | wasmer ssh"])
//                 .output()
//                 .unwrap()
//                 .stdout
//         )
//         .unwrap()
//         .trim()
//     );
// }
Deno.test('ssh', async () => {
  const env = TestEnv.fromEnv();

  const runSsh = async (args: string[], stdin?: string) => {
    const output = await env.runWasmerCommand({
      args: ['ssh', ...args],
      stdin,
      noAssertSuccess: true,
    });
    const stdout = output.stdout.replace('\r\n', '\n').trim();
    return stdout;
  };

  {
    const res = await runSsh(['sharrattj/bash', '--', '-c', 'pwd']);
    assertEquals(res, '/');
  }

  {
    const res = await runSsh([], 'pwd\n');
    assertEquals(res, '/');
  }

  {
    const res = await runSsh(['sharrattj/bash', '--', '-c', 'ls']);
    const lines = res.trim().split('\n').map((line) => line.trim());
    assert(lines.includes('bin'));
    assert(lines.includes('dev'));
    assert(lines.includes('etc'));
    assert(lines.includes('tmp'));
  }

  {
    const res = await runSsh([], 'echo -n hello > test && cat test\n');
    assertEquals(res, 'hello');
  }
});
