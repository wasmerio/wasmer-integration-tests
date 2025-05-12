import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";
import * as toml from "jsr:@std/toml";
import * as path from "node:path";
import fs from "node:fs";

import {
  AppDefinition,
  buildJsWorkerApp,
  buildStaticSiteApp,
  buildTempDir,
  createTempDir,
  HEADER_INSTANCE_ID,
  HEADER_PURGE_INSTANCES,
  parseDeployOutput,
  randomAppName,
  sleep,
  TestEnv,
  writeAppDefinition,
} from "../../src/index.ts";

// TESTS

Deno.test("wasmer-cli-version", async function () {
  const env = TestEnv.fromEnv();
  const out = await env.runWasmerCommand({ args: ["-v", "--version"] });

  const data = out.stdout.trim().split("\n").reduce(
    (acc: Record<string, string>, line: string): Record<string, string> => {
      line = line.trim();
      if (line.includes(":")) {
        console.log({ line });
        const [key, value] = line.split(":");
        acc[key.trim()] = value.trim();
      }
      return acc;
    },
    {},
  );

  assertEquals(data["binary"], "wasmer-cli");
});

// Test that the instance purge header works correctly.
Deno.test("app-purge-instances", async () => {
  const spec = buildStaticSiteApp();

  // Enable debug mode to allow for instance ID and instance purging.
  spec.appYaml.debug = true;

  const env = TestEnv.fromEnv();
  const info = await env.deployApp(spec);

  const res = await env.fetchApp(info, "/");
  const instanceId1 = res.headers.get(HEADER_INSTANCE_ID);
  if (!instanceId1) {
    throw new Error(
      `Expected header ${HEADER_INSTANCE_ID} to be set in response`,
    );
  }

  const body1 = await res.text();
  assertEquals(body1, "<html><body>Hello!</body></html>");

  const res2 = await env.fetchApp(info, "/");
  const instanceId2 = res2.headers.get(HEADER_INSTANCE_ID);
  if (!instanceId2) {
    throw new Error(
      `Expected header ${HEADER_INSTANCE_ID} to be set in response`,
    );
  }
  assertEquals(instanceId1, instanceId2);
  await res2.body?.cancel();

  console.info("App deployed, purging instances...");

  // Purge the instance with the purge header.

  const res3 = await env.fetchApp(info, "/", {
    headers: {
      [HEADER_PURGE_INSTANCES]: "1",
    },
  });
  await res3.body?.cancel();

  const instanceId3 = res3.headers.get(HEADER_INSTANCE_ID);
  if (!instanceId3) {
    throw new Error(
      `Expected header ${HEADER_INSTANCE_ID} to be set in response`,
    );
  }
  assertNotEquals(instanceId1, instanceId3);

  // Now the instance should stay the same again.

  const res4 = await env.fetchApp(info, "/");
  await res4.body?.cancel();
  const instanceId4 = res4.headers.get(HEADER_INSTANCE_ID);
  if (!instanceId4) {
    throw new Error(
      `Expected header ${HEADER_INSTANCE_ID} to be set in response`,
    );
  }
  assertEquals(instanceId3, instanceId4);
  await env.deleteApp(info);
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
    info.url.replace("https://", "http://"),
    { noAssertSuccess: true, redirect: "manual" },
  );
  await res.body?.cancel();
  assertEquals(res.status, 308);
  assertEquals(res.headers.get("location")?.replace(/\/$/, ""), info.url);

  // Now redeploy the app with https redirect disabled.

  console.info("Re-deploying app with https redirect disabled...");

  spec.appYaml.redirect = { force_https: false };
  writeAppDefinition(info.dir, spec);
  const info2 = await env.deployAppDir(info.dir);

  const res2 = await env.fetchApp(
    info2,
    info2.url.replace("https://", "http://"),
    { redirect: "manual" },
  );
  console.log(await res2.text());
  assertEquals(res2.status, 200);
  await env.deleteApp(info);
});

// TODO: fix CGI!
Deno.test("app-python-wcgi", { ignore: true }, async () => {
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
            "main-args": ["/src/main.py"],
          },
        },
      }],
    },
    appYaml: {
      kind: "wasmer.io/App.v0",
      package: ".",
    },
    files: {
      "src": {
        "main.py": `
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

  const res = await env.fetchApp(info, "/");
  const body = await res.text();
  assertEquals(body.trim(), "<html><body><h1>Hello, World!</h1></body></html>");
  await env.deleteApp(info);
});

Deno.test("app-winterjs", async () => {
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
            "main-args": ["/src/main.js"],
          },
        },
      }],
    },
    appYaml: {
      kind: "wasmer.io/App.v0",
      package: ".",
    },
    files: {
      "src": {
        "main.js": `
addEventListener('fetch', (req) => {
    req.respondWith(new Response('Hello World!'));
});
        `,
      },
    },
  };

  const info = await env.deployApp(spec);
  const res = await env.fetchApp(info, "/");
  const body = await res.text();

  assertEquals(body, "Hello World!");
  await env.deleteApp(info);
});

Deno.test("app-php", async () => {
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
            "main-args": ["-t", "/src", "-S", "localhost:8080"],
          },
        },
      }],
    },
    appYaml: {
      kind: "wasmer.io/App.v0",
      package: ".",
    },
    files: {
      "src": {
        "index.php": `
<?php
echo $_GET["name"];
        `,
      },
    },
  };

  const info = await env.deployApp(spec);
  const res = await env.fetchApp(info, "/?name=world");
  const body = await res.text();
  assertEquals(body.trim(), "world");
  await env.deleteApp(info);
});

Deno.test("app-rust-axum", { ignore: true }, async () => {
  const env = TestEnv.fromEnv();

  const spec: AppDefinition = {
    appYaml: {
      kind: "wasmer.io/App.v0",
      package: "wasmer-integration-tests/axum",
    },
  };

  const info = await env.deployApp(spec);
  const res = await env.fetchApp(info, "/?name=world");
  const body = await res.text();
  assertEquals(body.trim(), '{"name": "world"}');
  await env.deleteApp(info);
});

Deno.test("recreate-app-with-same-name", async () => {
  const env = TestEnv.fromEnv();
  const spec = buildStaticSiteApp();
  spec.files!.public["index.html"] = "version ALPHA";
  const info = await env.deployApp(spec);
  const res = await env.fetchApp(info, "/");
  const body = await res.text();
  assertEquals(body, "version ALPHA");

  console.log("Deleting app", { info });
  await env.deleteApp(info);

  console.log("Sleeping...");
  sleep(5_000);

  // Now deploy the app again with the same name but different content.
  spec.files!.public["index.html"] = "version BETA";
  const info2 = await env.deployApp(spec);
  const res2 = await env.fetchApp(info2, "/");
  const body2 = await res2.text();
  assertEquals(body2, "version BETA");
  await env.deleteApp(info2);
});

Deno.test("app-listing", async () => {
  const env = TestEnv.fromEnv();
  const spec = buildStaticSiteApp();
  const info = await env.deployApp(spec);

  console.log("Test app deployed, retrieving app listing...");

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

  console.log("App listing loaded, searching for test app in listing...");

  const apps = JSON.parse(listing.stdout);

  const foundApp = apps.find((app: { name: string }) =>
    app.name === info.version.name
  );

  if (!foundApp) {
    throw new Error(`App not found in listing: ${info.version.name}`);
  }
  console.log("App found in listing:", { app: foundApp });
  await env.deleteApp(info);
});

// Create an app, delete it again and ensure that the app is not accessible
// anymore.
//
// TODO: ignored because app deletion seems to be problematic ATM
Deno.test("app-delete", { ignore: true }, async () => {
  const env = TestEnv.fromEnv();
  const spec = buildStaticSiteApp();
  const domain = spec.appYaml!.name + "." + env.appDomain;
  spec.appYaml.domains = [domain];
  const info = await env.deployApp(spec);

  console.log("Delete app...");

  // Test left as is
  // const listing = await env.runWasmerCommand({
  //   args: [
  //     "app",
  //     "delete",
  //   ],
  //   cwd: info.dir,
  // });

  console.log("App deleted, waiting for app to become inaccessible...");

  const start = Date.now();

  const url = `https://${domain}/`;

  while (true) {
    const res = await env.fetchApp(info, url, { noAssertSuccess: true });
    if (res.status === 400) {
      console.log("App is no longer accessible");
      break;
    } else {
      console.log("App still accessible ... waiting ...");
      const elapsed = Date.now() - start;
      if (elapsed > 60_000) {
        throw new Error("App is still accessible after 60 seconds");
      }
      await sleep(10_000);
    }
  }
  await env.deleteApp(info);
});

Deno.test("app-info-get", async () => {
  const env = TestEnv.fromEnv();
  const spec = buildStaticSiteApp();
  const info = await env.deployApp(spec);

  // Test "app info"
  const output = await env.runWasmerCommand({
    args: ["app", "info"],
    cwd: info.dir,
  });

  const expectedUrl = `https://${info.version.name}.${env.appDomain}`;

  const stdout = output.stdout;

  assert(stdout.includes(`Name: ${info.version.name}`));
  assert(stdout.includes(`URL: ${expectedUrl}`));

  // Test "app get"
  const output2 = await env.runWasmerCommand({
    args: ["app", "get", "--format", "json"],
    cwd: info.dir,
  });

  const json = JSON.parse(output2.stdout);
  assertEquals(json.name, info.version.name);
  assertEquals(json.url, expectedUrl);
  await env.deleteApp(info);
});

Deno.test("app-create-from-package", async () => {
  const env = TestEnv.fromEnv();
  const name = randomAppName();
  const fullName = `${env.namespace}/${name}`;

  const spec = buildStaticSiteApp();
  const pkgSpec = spec.wasmerToml!;
  pkgSpec.package = { name: `${env.namespace}/${name}`, version: "0.1.0" };

  console.log("Publishing package...");

  const pkgDir = await buildTempDir({
    "wasmer.toml": `
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
    "public": {
      "index.html": name,
    },
  });

  await env.runWasmerCommand({
    args: ["publish"],
    cwd: pkgDir,
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
      "--format",
      "json",
    ],
    cwd: appDir,
  });
  const version = parseDeployOutput(output.stdout, pkgDir);
  const info = await env.resolveAppInfoFromVersion(version, pkgDir);

  const res = await env.fetchApp(info, "/");
  const body = await res.text();
  assertEquals(body.trim(), name);
  await env.deleteApp(info);
});

Deno.test("app-update-multiple-times", async () => {
  const env = TestEnv.fromEnv();
  const spec = buildStaticSiteApp();
  const info1 = await env.deployApp(spec);

  const indexPath = path.join(info1.dir, "public/index.html");

  for (let i = 0; i < 3; i++) {
    const content = `hello-${i}`;
    await fs.promises.writeFile(indexPath, content);
    await env.deployAppDir(info1.dir);

    const res = await env.fetchApp(info1, "/");
    const body = await res.text();
    assertEquals(body.trim(), content);
  }
  await env.deleteApp(info1);
});

Deno.test("app-logs", async () => {
  const env = TestEnv.fromEnv();
  const code = `

addEventListener("fetch", (fetchEvent) => {
  console.log('hello logs')
  fetchEvent.respondWith(new Response('ok'));
});

  `;
  const spec = buildJsWorkerApp(code);
  const info = await env.deployApp(spec);

  const start = Date.now();
  while (true) {
    const output = await env.runWasmerCommand({
      args: ["app", "logs"],
      cwd: info.dir,
    });

    if (output.stdout.includes("hello logs")) {
      console.log("Logs found in output");
      break;
    } else {
      const elapsed = Date.now() - start;
      if (elapsed > 60_000) {
        throw new Error("Logs not found after 60 seconds");
      }
    }
  }
  await env.deleteApp(info);
});

Deno.test("dns-zonefile", async () => {
  const env = TestEnv.fromEnv();
  const tmpDir = await createTempDir();

  const id = crypto.randomUUID().replace(/-/g, "");
  const domain = `${id}.com`;

  // Register the domain.
  await env.runWasmerCommand({
    args: ["domain", "register", domain],
  });

  // Get the zone file, just to make sure it works.
  const output = await env.runWasmerCommand({
    args: ["domain", "get-zone-file", domain],
  });
  let zoneFile = output.stdout;
  zoneFile += "$TTL 3600\nsub IN A 127.0.0.1";

  const subdomain = `sub.${domain}`;

  const zoneFilePath = path.join(tmpDir, "zonefile");
  await fs.promises.writeFile(zoneFilePath, zoneFile);

  // Sync the zone file.
  await env.runWasmerCommand({
    args: ["domain", "sync-zone-file", zoneFilePath],
  });

  // Resolve a server in the cluster.
  console.log("Resolving Edge DNS server ip...");
  const aRecords = await Deno.resolveDns(env.appDomain, "A");
  if (aRecords.length === 0) {
    throw new Error(`No DNS A records found for ${env.appDomain}`);
  }
  const dnsServerIp = aRecords[0];
  console.log("Resolved Edge DNS server ip: " + dnsServerIp);

  // Resolve the custom domain.

  const start = Date.now();
  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed > 60_000) {
      throw new Error(
        "Timeout while waiting for DNS records to become available",
      );
    }

    console.log("Resolving custom domain", { subdomain, dnsServerIp });
    let domainRecords;
    try {
      domainRecords = await Deno.resolveDns(subdomain.trim(), "A", {
        nameServer: { ipAddr: dnsServerIp, port: 53 },
      });
    } catch (error) {
      console.error("Error while resolving DNS records ... retrying ...", {
        error,
      });
      await sleep(3_000);
      continue;
    }

    console.log("Resolved", { domainRecords });
    const isMatch = domainRecords.length === 1 &&
      domainRecords[0] === "127.0.0.1";
    if (isMatch) {
      break;
    } else {
      console.log("DNS records do not match yet, waiting...", {
        domainRecords,
      });
      await sleep(3_000);
    }
  }
});

Deno.test("package-download-named", async () => {
  const env = TestEnv.fromEnv();

  const name = randomAppName();
  const fullName = `${env.namespace}/${name}`;

  const wasmerToml = toml.stringify({
    package: {
      name: fullName,
      version: "0.0.1",
    },
    fs: {
      "data": "./data",
    },
  });
  const files = {
    "wasmer.toml": wasmerToml,
    data: {
      "a.txt": "a",
      "b": {
        "b.txt": "b",
      },
    },
  };
  const dir = await buildTempDir(files);

  // Publish the package.
  await env.runWasmerCommand({
    args: ["publish"],
    cwd: dir,
  });

  // Download again.
  const webcPath = path.join(dir, "dl.webc");
  await env.runWasmerCommand({
    args: ["package", "download", fullName, "-o", webcPath],
  });

  const unpackDir = path.join(dir, "unpacked");
  await env.runWasmerCommand({
    args: ["package", "unpack", webcPath, "-o", unpackDir],
  });

  const dataDir = path.join(unpackDir, "data");

  assertEquals(
    await fs.promises.readFile(path.join(dataDir, "a.txt"), "utf-8"),
    "a",
  );
  assertEquals(
    await fs.promises.readFile(path.join(dataDir, "b/b.txt"), "utf-8"),
    "b",
  );
});

Deno.test("package-download-unnamed", async () => {
  const env = TestEnv.fromEnv();

  const wasmerToml = toml.stringify({
    fs: {
      "data": "./data",
    },
  });
  const files = {
    "wasmer.toml": wasmerToml,
    data: {
      "a.txt": "a",
      "b": {
        "b.txt": "b",
      },
    },
  };
  const dir = await buildTempDir(files);

  // Upload the package.
  const output = await env.runWasmerCommand({
    args: ["package", "push", "--namespace", env.namespace],
    cwd: dir,
  });

  // Parse the hash from the output.
  const out = output.stderr;
  console.log("Parsing output: " + out);
  const hash = out.split("sha256:")[1].substring(0, 64);
  if (hash.length !== 64) {
    throw new Error(`Hash not found in output: ${out}`);
  }

  // Download
  const webcPath = path.join(dir, "out.webc");
  await env.runWasmerCommand({
    args: ["package", "download", `sha256:${hash}`, "-o", webcPath],
  });

  // Unpack
  const unpackDir = path.join(dir, "unpacked");
  await env.runWasmerCommand({
    args: ["package", "unpack", webcPath, "-o", unpackDir],
  });

  const dataDir = path.join(unpackDir, "data");
  assertEquals(
    await fs.promises.readFile(path.join(dataDir, "a.txt"), "utf-8"),
    "a",
  );
  assertEquals(
    await fs.promises.readFile(path.join(dataDir, "b/b.txt"), "utf-8"),
    "b",
  );
});

Deno.test("package-publish-and-run", async () => {
  const env = TestEnv.fromEnv();
  const name = randomAppName();
  const fullName = `${env.namespace}/${name}`;

  const wasmerToml = toml.stringify({
    package: {
      name: fullName,
      version: "0.0.1",
    },
    dependencies: {
      "wasmer/python": "3",
    },
    fs: {
      "src": "./src",
    },
    command: [{
      name: "script",
      module: "wasmer/python:python",
      runner: "https://webc.org/runner/wasi",
      annotations: {
        wasi: {
          "main-args": ["/src/main.py"],
        },
      },
    }],
  });

  const files = {
    "wasmer.toml": wasmerToml,
    src: {
      "main.py": `print("${fullName}")`,
    },
  };

  const dir = await buildTempDir(files);

  await env.runWasmerCommand({
    args: ["publish"],
    cwd: dir,
  });

  console.log("Running package...");
  const output = await env.runWasmerCommand({
    args: ["run", fullName],
  });

  console.log(`Output: "${output.stdout}"`);

  assertEquals(output.stdout.trim(), fullName);
});

Deno.test("cli-run-python", async () => {
  const env = TestEnv.fromEnv();
  const output = await env.runWasmerCommand({
    args: ["run", "wasmer/python", "--", "-c", "print(40 + 2)"],
  });

  assertEquals(output.stdout.trim(), "42");
});

Deno.test("app-secrets-fullstack", async () => {
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
    args: ["app", "secret", "create", "--app", info.id, "s1", "v1"],
  });
  {
    const output = await env.runWasmerCommand({
      args: ["app", "secret", "reveal", "--app", info.id, "s1"],
    });
    assertEquals(output.stdout.trim(), "v1");
  }

  await env.runWasmerCommand({
    args: ["app", "secret", "create", "--app", info.id, "s2", "v2"],
  });
  {
    const output = await env.runWasmerCommand({
      args: ["app", "secret", "reveal", "--app", info.id, "s2"],
    });
    assertEquals(output.stdout.trim(), "v2");
  }

  // make sure long secrets work.
  const valueLong = "x".repeat(10240);
  await env.runWasmerCommand({
    args: ["app", "secret", "create", "--app", info.id, "slong", valueLong],
  });
  {
    const output = await env.runWasmerCommand({
      args: ["app", "secret", "reveal", "--app", info.id, "slong"],
    });
    assertEquals(output.stdout.trim(), valueLong);
  }

  // Listing works
  {
    const output = await env.runWasmerCommand({
      args: ["app", "secret", "list", "--app", info.id],
    });

    const lines = output.stdout.trim().split("\n").map((line) =>
      line.trim().split(" ")[0]
    );
    console.log("Retrieved secrets list", { lines });
    assert(lines.includes("s1"));
    assert(lines.includes("s2"));
    assert(lines.includes("slong"));
  }

  // Redeploy app to apply secrets.
  await env.deployAppDir(info.dir);

  // Fetch the app and check the response.
  {
    const res = await env.fetchApp(info, "/");
    const body = await res.text();
    const data = JSON.parse(body);
    console.log("Retrieved app response", { data });
    assertEquals(data.env["s1"], "v1");
    assertEquals(data.env["s2"], "v2");
    assertEquals(data.env["slong"], valueLong);
  }

  // Update a secret value.
  await env.runWasmerCommand({
    args: ["app", "secret", "update", "--app", info.id, "s1", "v1-updated"],
  });
  {
    const output = await env.runWasmerCommand({
      args: ["app", "secret", "reveal", "--app", info.id, "s1"],
    });
    assertEquals(output.stdout.trim(), "v1-updated");
  }

  // Deploy again to apply the updated secret.
  await env.deployAppDir(info.dir);

  // Check response.
  {
    const res = await env.fetchApp(info, "/");
    const body = await res.text();
    const data = JSON.parse(body);
    console.log("Retrieved app response", { data });
    assertEquals(data.env["s1"], "v1-updated");
    assertEquals(data.env["s2"], "v2");
    assertEquals(data.env["slong"], valueLong);
  }

  // Delete a secret.
  await env.runWasmerCommand({
    args: ["app", "secret", "delete", "--app", info.id, "s1"],
  });

  // Listing should not have the secret anymore
  {
    const output = await env.runWasmerCommand({
      args: ["app", "secret", "list", "--app", info.id],
    });
    const lines = output.stdout.trim().split("\n").map((line) =>
      line.trim().split(" ")[0]
    );
    assert(!lines.includes("s1"));
  }

  // Deploy again.
  await env.deployAppDir(info.dir);

  // Check response.
  {
    const res = await env.fetchApp(info, "/");
    const body = await res.text();
    const data = JSON.parse(body);
    console.log("Retrieved app response", { data });
    assertEquals(data.env["s2"], "v2");
    assertEquals(data.env["slong"], valueLong);
    assertEquals(data.env["s1"], undefined);
  }
  await env.deleteApp(info);
});

Deno.test("deploy-fails-without-app-name", async () => {
  const env = TestEnv.fromEnv();

  const spec = buildStaticSiteApp();
  spec.appYaml.owner = env.namespace;
  delete spec.appYaml.name;

  const dir = await createTempDir();
  await writeAppDefinition(dir, spec);

  try {
    await env.deployAppDir(dir, { noWait: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.log("Deploy failed with error: " + message);
    assert(message.includes("does not specify any app name"));
    return;
  }

  throw new Error("Expected deploy to fail without app name");
});

Deno.test("deploy-fails-without-owner", async () => {
  const env = TestEnv.fromEnv();

  const spec = buildStaticSiteApp();

  const dir = await createTempDir();
  await writeAppDefinition(dir, spec);

  try {
    await env.deployAppDir(dir, { noWait: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.log("Deploy failed with error: " + message);
    assert(message.includes("No owner specified"));
    return;
  }

  throw new Error("Expected deploy to fail without app name");
});
