import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "jsr:@std/assert";
import * as toml from "jsr:@std/toml";
import * as path from "node:path";
import fs from "node:fs";

import {
  AppDefinition,
  buildJsWorkerApp,
  buildPhpApp,
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
} from "../src/index.ts";

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

// Currently ignored due to IP setup related failures.
// SEE SRE-656
Deno.test("ssh", { ignore: true }, async () => {
  const env = TestEnv.fromEnv();

  const runSsh = async (args: string[], stdin?: string) => {
    const output = await env.runWasmerCommand({
      args: ["ssh", ...args],
      stdin,
      noAssertSuccess: true,
    });
    const stdout = output.stdout.replace("\r\n", "\n").trim();
    return stdout;
  };

  {
    const res = await runSsh(["sharrattj/bash", "--", "-c", "pwd"]);
    assertEquals(res, "/");
  }

  {
    const res = await runSsh([], "pwd\n");
    assertEquals(res, "/");
  }

  {
    const res = await runSsh(["sharrattj/bash", "--", "-c", "ls"]);
    const lines = res.trim().split("\n").map((line) => line.trim());
    assert(lines.includes("bin"));
    assert(lines.includes("dev"));
    assert(lines.includes("etc"));
    assert(lines.includes("tmp"));
  }

  {
    const res = await runSsh([], "echo -n hello > test && cat test\n");
    assertEquals(res, "hello");
  }
});

class DeveloperMailClient {
  private name: string;
  private token: string;

  static TOKEN_HEADER = "X-MailboxToken";

  constructor(name: string, token: string) {
    this.name = name;
    this.token = token;
  }

  static async createMailbox(): Promise<DeveloperMailClient> {
    interface CreateMailboxResponse {
      success: boolean;
      error?: string | null;
      result?: {
        name: string;
        token: string;
      };
    }

    const res = await fetch("https://www.developermail.com/api/v1/mailbox", {
      method: "PUT",
      headers: {
        "accept": "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to create mailbox: ${res.status}: ${body}`);
    }
    const data: CreateMailboxResponse = await res.json();
    if (!data.success) {
      throw new Error(`Failed to create mailbox: ${data.error}`);
    }
    if (!data.result) {
      throw new Error("Failed to create mailbox: no result");
    }
    return new DeveloperMailClient(data.result.name, data.result.token);
  }

  email(): string {
    return `${this.name}@developermail.com`;
  }

  async messageIds(): Promise<string[]> {
    const res = await fetch(
      `https://www.developermail.com/api/v1/mailbox/${this.name}`,
      {
        headers: {
          "accept": "application/json",
          [DeveloperMailClient.TOKEN_HEADER]: this.token,
        },
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to get mailbox messages: ${res.status}: ${body}`);
    }
    const data = await res.json();
    if (!data.success) {
      throw new Error(`Failed to get mailbox messages: ${data.error}`);
    }
    if (!data.result || !Array.isArray(data.result)) {
      throw new Error("Failed to get mailbox messages: no result");
    }
    // deno-lint-ignore no-explicit-any
    if (!data.result.every((id: any) => typeof id === "string")) {
      throw new Error(
        "Failed to get mailbox messages: invalid result, expected an array of strings",
      );
    }
    return data.result;
  }

  async messages(ids: string[]): Promise<string[]> {
    const url =
      `https://www.developermail.com/api/v1/mailbox/${this.name}/messages`;
    console.debug({ url, ids });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        [DeveloperMailClient.TOKEN_HEADER]: this.token,
        "accept": "application/json",
        "content-type": "application/json",
        body: JSON.stringify(ids),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to get mailbox messages: ${res.status}: ${body}`);
    }
    const data = await res.json();
    if (!data.success) {
      console.debug("Failed to retrieve mailbox messages", {
        ids,
        responseData: data,
      });
      throw new Error(`Failed to get mailbox messages: ${data.error}`);
    }
    if (!data.result || !Array.isArray(data.result)) {
      throw new Error("Failed to get mailbox messages: no result");
    }

    // deno-lint-ignore no-explicit-any
    return data.result.map((item: any) => item.value);
  }

  async waitForMessageIds(): Promise<string[]> {
    let messageIds: string[] | null = null;

    while (true) {
      console.debug("Checking for messages...");
      let ids: string[] = [];
      try {
        ids = await this.messageIds();
      } catch (error) {
        // deno-lint-ignore no-explicit-any
        const message = (error as any).toString?.() || "unknown error";
        console.warn("Failed to get mailbox message ids:", {
          message,
          error,
        });
        continue;
      }
      if (ids.length > 0) {
        messageIds = ids;
        break;
      }
      // No messages yet, wait a bit.
      await sleep(3_000);
    }
    return messageIds;
  }

  async waitForMessages(): Promise<string[]> {
    const messageIds = await this.waitForMessageIds();

    while (true) {
      console.debug("Loading messages", { messageIds });
      try {
        const messages = await this.messages(messageIds);
        return messages;
      } catch (error) {
        // deno-lint-ignore no-explicit-any
        const message = (error as any).toString?.() || "unknown error";
        console.warn("Failed to load mailbox messages:", { message, error });
      }
      await sleep(3_000);
    }
  }
}

// Test that the integrated email sending works.
Deno.test("php-email-sending", { ignore: true }, async () => {
  console.log("Creating a new mailbox...");
  const mbox = await DeveloperMailClient.createMailbox();
  console.log("Created mailbox:", { email: mbox.email() });

  const subject = "SUBJECT-" + randomAppName();
  const body = "BODY-" + randomAppName();

  const code = `<?php

error_reporting(E_ALL);
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');

$path = ltrim($_SERVER['SCRIPT_NAME'], '/');

error_log('handing path: "' . $path . '"');
if ($path !== 'send') {
  echo 'Use /send to send a mail';
  exit;
}

// Send the email.
$subject = "${subject}";
$body = "${body}";
echo "Sending email - subject: '$subject', body: '$body'\n";
mail("${mbox.email()}", "${subject}", "${body}");
echo "email_sent\n";
  `;

  const spec = buildPhpApp(code);
  spec.wasmerToml!["dependencies"] = {
    "php/php": "8.3.402",
  };
  // const info = await env.deployApp(spec);

  console.log("Sending request to app to trigger email sending...");
  // const res = await env.fetchApp(info, "/send");
  // const resBody = await res.text();
  // assertEquals(resBody.trim(), 'email_sent');

  console.log("App responded with ok - waiting for email to arrive...");

  const ids = await mbox.waitForMessageIds();
  if (ids.length === 0) {
    throw new Error("No messages found in mailbox");
  }
  // Note: commented out because apparently the mailbox api throws an error
  // when the source sender is undefined.
  // const messages = await mbox.waitForMessages();
  //
  // console.debug('Received messages:', { messages });
  //
  // const first = messages[0];
  // if (!first.includes(subject)) {
  //   throw new Error(`Email does not contain expected subject '${subject}': ${first}`);
  // }
  // if (!first.includes(body)) {
  //   throw new Error(`Email does not contain expected body '${body}': ${first}`);
  // }
});

// NOTE: Currently disabled due to problematic BE behaviour
// SEE WAX-373
// FIXME: re-enable once the BE behaviour is fixed (WAX-373)
Deno.test("sql-connectivity", { ignore: true }, async () => {
  const env = TestEnv.fromEnv();
  const filePath = "./fixtures/v2/php/mysql-check.php";
  const testCode = await fs.promises.readFile(filePath, "utf-8");

  // Validate that DB credentials aren't setup without specifying to have it
  {
    console.log("== Setting up environment without SQL ==");
    const want = "Missing required SQL environment variables";
    const withoutSqlSpec = buildPhpApp(testCode);
    const withoutSqlInfo = await env.deployApp(withoutSqlSpec);
    const res = await env.fetchApp(withoutSqlInfo, "/results");
    const got = await res.text();
    assertStringIncludes(
      got,
      want,
      "Expected environment to NOT include SQL details, as the environment is not specified to include them",
    );
    // Having environment variables set is bad, having the option to connect is worse: would
    // encourage and perhaps enable malicious use
    assertNotEquals(
      got,
      "OK",
      "It appears to be possible to connect to a DB from an unconfigured environment. Very not good!",
    );
    env.deleteApp(withoutSqlInfo);
  }

  // Validate happy-path
  console.log("== Setting up environment with SQL ==");
  const want = "OK";
  const withSqlSpec = buildPhpApp(testCode, {
    debug: true,
    scaling: {
      mode: "single_concurrency",
    },
    capabilities: {
      database: {
        engine: "mysql",
      },
    },
  });
  const withSqlInfo = await env.deployApp(withSqlSpec);

  {
    const res = await env.fetchApp(withSqlInfo, "/results");
    const got = await res.text();
    assertEquals(got, want);
  }

  // Also test the app version URL to make sure it is configured properly.
  // Reggression test for WAX-373
  {
    const url = withSqlInfo.version.url + "/results";
    const res = await fetch(url);
    const body = await res.text();
    assertEquals(body, want);
  }

  env.deleteApp(withSqlInfo);
});
