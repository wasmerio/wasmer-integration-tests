#!/usr/bin/env node
/* global Blob, FormData, console, fetch, process */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import toml from "@iarna/toml";
import yaml from "js-yaml";

const execFileAsync = promisify(execFile);

const repoDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const runDir = process.argv[3] ? path.resolve(process.argv[3]) : null;

const targetRegistry = process.env.WASMER_REGISTRY;
const targetToken = process.env.WASMER_TOKEN;
const sourceRegistry =
  process.env.LOCAL_PLATFORM_PACKAGE_SOURCE_REGISTRY ??
  "https://registry.wasmer.io/graphql";
const sourceToken = process.env.LOCAL_PLATFORM_PACKAGE_SOURCE_TOKEN;
const seedFile = path.resolve(
  repoDir,
  process.env.LOCAL_PLATFORM_PACKAGE_SEED_FILE ??
    "local-platform/package-seed.txt",
);
const cacheDir = path.resolve(
  repoDir,
  process.env.LOCAL_PLATFORM_PACKAGE_CACHE_DIR ??
    ".local-platform/package-cache",
);
const discoveryOutputPath = runDir
  ? path.join(runDir, "diagnostics", "package-seed.json")
  : null;
const wasmerDownloadLogPath = runDir
  ? path.join(runDir, "logs", "wasmer-package-download.log")
  : null;
let latestDiagnostics = null;
const directRefNamespaceAllowlist = new Set(
  (
    process.env.LOCAL_PLATFORM_PACKAGE_DIRECT_REF_NAMESPACE_ALLOWLIST ??
    "wasmer"
  )
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean),
);
const scanDirs = (
  process.env.LOCAL_PLATFORM_PACKAGE_SCAN_DIRS ??
  "tests,wasmopticon,wordpress/wasmer.toml,fixtures,src/app"
)
  .split(",")
  .map((part) => part.trim())
  .filter(Boolean);
const verbose = /^(1|true|yes|on)$/i.test(process.env.VERBOSE ?? "");
const dryRun = /^(1|true|yes|on)$/i.test(
  process.env.LOCAL_PLATFORM_PACKAGE_SEED_DRY_RUN ?? "",
);

if (!targetRegistry && !dryRun) {
  throw new Error("WASMER_REGISTRY is required for local package seeding");
}
if (!targetToken && !dryRun) {
  throw new Error("WASMER_TOKEN is required for local package seeding");
}

function log(message) {
  if (verbose) {
    console.log(`[package-seed] ${message}`);
  }
}

function debug(message) {
  if (verbose) {
    console.debug(`[package-seed] ${message}`);
  }
}

async function appendDownloadLog(message) {
  if (!wasmerDownloadLogPath) {
    return;
  }
  await fs.promises.mkdir(path.dirname(wasmerDownloadLogPath), {
    recursive: true,
  });
  await fs.promises.appendFile(wasmerDownloadLogPath, `${message}\n`);
}

async function writeDiagnostics(extra = {}) {
  if (!discoveryOutputPath || !latestDiagnostics) {
    return;
  }
  await fs.promises.mkdir(path.dirname(discoveryOutputPath), {
    recursive: true,
  });
  await fs.promises.writeFile(
    discoveryOutputPath,
    `${JSON.stringify({ ...latestDiagnostics, ...extra }, null, 2)}\n`,
  );
}

function isValidPackageName(value) {
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    /^[a-z0-9_.-]+$/i.test(parts[0]) &&
    /^[a-z0-9_.-]+$/i.test(parts[1])
  );
}

function parsePackageSpec(raw) {
  const spec = raw.trim();
  if (!spec || spec.startsWith("#")) {
    return null;
  }

  const withoutInlineComment = spec.replace(/\s+#.*$/, "").trim();
  const spaceSeparated = withoutInlineComment.match(
    /^([a-z0-9_.-]+\/[a-z0-9_.-]+)\s+(.+)$/i,
  );
  if (spaceSeparated) {
    return {
      name: spaceSeparated[1],
      constraint: spaceSeparated[2].trim() || "*",
    };
  }

  const atIndex = withoutInlineComment.indexOf("@");
  if (atIndex === -1) {
    return { name: withoutInlineComment, constraint: "*" };
  }

  return {
    name: withoutInlineComment.slice(0, atIndex),
    constraint: withoutInlineComment.slice(atIndex + 1) || "*",
  };
}

function addRequirement(requirements, name, constraint, source) {
  if (!isValidPackageName(name)) {
    return;
  }

  const normalizedConstraint = String(constraint || "*").trim() || "*";
  const key = `${name}@${normalizedConstraint}`;
  const existing = requirements.get(key);
  if (existing) {
    existing.sources.push(source);
  } else {
    requirements.set(key, {
      name,
      constraint: normalizedConstraint,
      sources: [source],
    });
  }
}

async function findFiles(root, predicate) {
  const result = [];

  let rootStat;
  try {
    rootStat = await fs.promises.stat(root);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return result;
    }
    throw err;
  }

  if (rootStat.isFile()) {
    if (predicate(root)) {
      result.push(root);
    }
    return result;
  }

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") {
        return;
      }
      throw err;
    }

    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === ".local-platform"
      ) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (predicate(fullPath)) {
        result.push(fullPath);
      }
    }
  }

  await walk(root);
  return result;
}

function discoverFromToml(filePath, raw, requirements) {
  let parsed;
  try {
    parsed = toml.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err}`);
  }

  const dependencies = parsed?.dependencies;
  if (!dependencies || typeof dependencies !== "object") {
    return;
  }

  for (const [name, constraint] of Object.entries(dependencies)) {
    if (typeof constraint === "string") {
      addRequirement(requirements, name, constraint, filePath);
    }
  }
}

function discoverFromYaml(filePath, raw, requirements) {
  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err}`);
  }

  const manifest = parsed?.wasmerToml;
  const dependencies = manifest?.dependencies;
  if (!dependencies || typeof dependencies !== "object") {
    return;
  }

  for (const [name, constraint] of Object.entries(dependencies)) {
    if (typeof constraint === "string") {
      addRequirement(requirements, name, constraint, filePath);
    }
  }
}

function discoverFromSource(filePath, raw, requirements) {
  const dependencyEntryRe =
    /["']([a-z0-9_.-]+\/[a-z0-9_.-]+)["']\s*:\s*["']([^"']+)["']/gi;
  for (const match of raw.matchAll(dependencyEntryRe)) {
    addRequirement(requirements, match[1], match[2], filePath);
  }

  const packageRefRe = /["']([a-z0-9_.-]+\/[a-z0-9_.-]+)(?:@([^"'\s]+))?["']/gi;
  for (const match of raw.matchAll(packageRefRe)) {
    const namespace = match[1].split("/")[0];
    if (directRefNamespaceAllowlist.has(namespace)) {
      addRequirement(requirements, match[1], match[2] ?? "*", filePath);
    }
  }
}

async function discoverRequirements() {
  const requirements = new Map();

  for (const scanDir of scanDirs) {
    const absoluteScanDir = path.resolve(repoDir, scanDir);
    const files = await findFiles(absoluteScanDir, (filePath) => {
      const ext = path.extname(filePath);
      return [".toml", ".yaml", ".yml", ".ts", ".js", ".mjs"].includes(ext);
    });

    for (const filePath of files) {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const ext = path.extname(filePath);
      if (path.basename(filePath) === "wasmer.toml") {
        discoverFromToml(filePath, raw, requirements);
      } else if (ext === ".yaml" || ext === ".yml") {
        discoverFromYaml(filePath, raw, requirements);
      } else {
        discoverFromSource(filePath, raw, requirements);
      }
    }
  }

  if (fs.existsSync(seedFile)) {
    const raw = await fs.promises.readFile(seedFile, "utf8");
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      const parsed = parsePackageSpec(line);
      if (parsed) {
        addRequirement(
          requirements,
          parsed.name,
          parsed.constraint,
          `${seedFile}:${index + 1}`,
        );
      }
    }
  }

  return [...requirements.values()].sort((a, b) =>
    `${a.name}@${a.constraint}`.localeCompare(`${b.name}@${b.constraint}`),
  );
}

async function graphql(registry, token, query, variables) {
  const headers = { "content-type": "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(registry, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    throw new Error(
      `GraphQL response from ${registry} was not JSON (${response.status}): ${body.slice(0, 500)}: ${err}`,
    );
  }

  if (!response.ok || data.errors?.length) {
    const message =
      data.errors?.map((error) => error.message).join("; ") ?? body;
    throw new Error(`GraphQL request to ${registry} failed: ${message}`);
  }

  return data.data;
}

const tinyPngBytes = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120,
  156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68,
  174, 66, 96, 130,
]);
const ensuredNamespaces = new Set();

const packageVersionQuery = `
  query PackageVersion($name: String!, $version: String) {
    getPackageVersion(name: $name, version: $version) {
      version
      manifest
      package { name }
      dependencies {
        edges {
          node {
            version
            package { name }
          }
        }
      }
    }
  }
`;

async function resolveSourceRequirement(requirement) {
  const data = await graphql(sourceRegistry, sourceToken, packageVersionQuery, {
    name: requirement.name,
    version: requirement.constraint,
  });
  const version = data.getPackageVersion;
  if (!version) {
    throw new Error(
      `Source registry ${sourceRegistry} does not have ${requirement.name}@${requirement.constraint}`,
    );
  }

  const dependencies = (version.dependencies?.edges ?? [])
    .map((edge) => edge?.node)
    .filter(Boolean)
    .map((node) => ({
      name: node.package.name,
      constraint: `=${node.version}`,
    }));

  if (typeof version.manifest === "string" && version.manifest.trim()) {
    try {
      const manifest = toml.parse(version.manifest);
      const manifestDependencies = manifest?.dependencies;
      if (manifestDependencies && typeof manifestDependencies === "object") {
        for (const [name, constraint] of Object.entries(manifestDependencies)) {
          if (typeof constraint === "string") {
            dependencies.push({ name, constraint });
          }
        }
      }
    } catch (err) {
      debug(
        `Could not parse source manifest for ${requirement.name}@${requirement.constraint}: ${err}`,
      );
    }
  }

  return {
    ...requirement,
    resolvedName: version.package.name,
    resolvedVersion: version.version,
    manifest: version.manifest,
    dependencies,
  };
}

async function resolveAllRequirements(initialRequirements) {
  const resolvedByExact = new Map();
  const queue = [...initialRequirements];

  while (queue.length > 0) {
    const requirement = queue.shift();
    const resolved = await resolveSourceRequirement(requirement);
    const exactKey = `${resolved.resolvedName}@${resolved.resolvedVersion}`;
    const existing = resolvedByExact.get(exactKey);
    if (existing) {
      existing.sources.push(...requirement.sources);
      continue;
    }
    resolvedByExact.set(exactKey, resolved);

    for (const dependency of resolved.dependencies) {
      if (!isValidPackageName(dependency.name)) {
        continue;
      }
      queue.push({
        name: dependency.name,
        constraint: dependency.constraint,
        sources: [`dependency of ${exactKey}`],
      });
    }
  }

  return [...resolvedByExact.values()].sort((a, b) => {
    const depCountDelta = a.dependencies.length - b.dependencies.length;
    if (depCountDelta !== 0) {
      return depCountDelta;
    }
    return `${a.resolvedName}@${a.resolvedVersion}`.localeCompare(
      `${b.resolvedName}@${b.resolvedVersion}`,
    );
  });
}

async function ensureTargetNamespace(namespace) {
  if (ensuredNamespaces.has(namespace)) {
    return;
  }

  const existing = await graphql(
    targetRegistry,
    targetToken,
    `
      query GetNamespace($name: String!) {
        getNamespace(name: $name) {
          id
        }
      }
    `,
    { name: namespace },
  );
  if (!existing.getNamespace) {
    log(`Creating local namespace ${namespace}`);
    const operations = JSON.stringify({
      query:
        "mutation CreateNamespace($input: CreateNamespaceInput!) { createNamespace(input: $input) { namespace { id name } } }",
      variables: {
        input: {
          name: namespace,
          displayName: namespace,
          avatarUpload: null,
        },
      },
    });
    const map = JSON.stringify({ 0: ["variables.input.avatarUpload"] });
    const form = new FormData();
    form.set("operations", operations);
    form.set("map", map);
    form.set(
      "0",
      new Blob([tinyPngBytes], { type: "image/png" }),
      "avatar.png",
    );

    const response = await fetch(targetRegistry, {
      method: "POST",
      headers: { authorization: `Bearer ${targetToken}` },
      body: form,
    });
    const body = await response.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch (err) {
      throw new Error(
        `CreateNamespace response for ${namespace} was not JSON (${response.status}): ${body.slice(0, 500)}: ${err}`,
      );
    }
    if (!response.ok || data.errors?.length) {
      const message =
        data.errors?.map((error) => error.message).join("; ") ?? body;
      throw new Error(
        `Failed to create local namespace ${namespace}: ${message}`,
      );
    }
  }

  ensuredNamespaces.add(namespace);
}

async function targetHasPackage(pkg) {
  try {
    const data = await graphql(
      targetRegistry,
      targetToken,
      packageVersionQuery,
      {
        name: pkg.resolvedName,
        version: `=${pkg.resolvedVersion}`,
      },
    );
    return Boolean(data.getPackageVersion);
  } catch (err) {
    debug(
      `Local existence check failed for ${pkg.resolvedName}@${pkg.resolvedVersion}: ${err}`,
    );
    return false;
  }
}

function safePackageFilename(pkg) {
  return `${pkg.resolvedName.replace(/[^a-z0-9_.-]+/gi, "_")}@${pkg.resolvedVersion.replace(/[^a-z0-9_.+-]+/gi, "_")}.webc`;
}

async function runWasmer(args, env, options = {}) {
  const command = `wasmer ${args.join(" ")}`;
  debug(command);
  try {
    const result = await execFileAsync("wasmer", args, {
      ...options,
      maxBuffer: 100 * 1024 * 1024,
      env: {
        ...process.env,
        ...env,
      },
    });
    if (verbose && result.stdout.trim()) {
      console.debug(result.stdout.trim());
    }
    if (verbose && result.stderr.trim()) {
      console.debug(result.stderr.trim());
    }
    return result;
  } catch (err) {
    const exitDetails = [
      err.code !== undefined ? `exitCode=${err.code}` : null,
      err.signal ? `signal=${err.signal}` : null,
      err.killed ? "killed=true" : null,
    ]
      .filter(Boolean)
      .join(" ");
    const stdout = err.stdout
      ? `\nstdout:\n${err.stdout}`
      : "\nstdout: <empty>";
    const stderr = err.stderr
      ? `\nstderr:\n${err.stderr}`
      : "\nstderr: <empty>";
    throw new Error(
      `${command} failed${exitDetails ? ` (${exitDetails})` : ""}${stdout}${stderr}`,
    );
  }
}

async function rebuildPackageAsWebcV3(pkg, packagePath) {
  const rebuiltPath = packagePath.replace(/\.webc$/, ".v3.webc");
  if (fs.existsSync(rebuiltPath) && fs.statSync(rebuiltPath).size > 0) {
    debug(
      `Using cached rebuilt webc v3 for ${pkg.resolvedName}@${pkg.resolvedVersion}`,
    );
    return rebuiltPath;
  }

  log(`Rebuilding ${pkg.resolvedName}@${pkg.resolvedVersion} as webc v3`);
  const workDir = path.join(cacheDir, `rebuild-${crypto.randomUUID()}`);
  const unpackDir = path.join(workDir, "unpacked");
  const tempOutput = `${rebuiltPath}.${crypto.randomUUID()}.tmp`;
  await fs.promises.mkdir(workDir, { recursive: true });
  try {
    await runWasmer(["package", "unpack", packagePath, "-o", unpackDir], {});
    await runWasmer(
      ["package", "build", unpackDir, "-o", tempOutput, "--quiet"],
      {},
    );
    await fs.promises.rename(tempOutput, rebuiltPath);
    return rebuiltPath;
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
    await fs.promises.rm(tempOutput, { force: true });
  }
}

async function uploadPackageBytes(signedUrl, packagePath) {
  const bytes = await fs.promises.readFile(packagePath);
  const response = await fetch(signedUrl, {
    method: "PUT",
    body: bytes,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Package upload failed (${response.status}) for ${packagePath}: ${body.slice(0, 500)}`,
    );
  }
}

async function publishPackage(pkg, namespace, name, packagePath) {
  if (!pkg.manifest) {
    throw new Error(
      `Source registry did not return a manifest for ${pkg.resolvedName}@${pkg.resolvedVersion}`,
    );
  }

  const upload = await graphql(
    targetRegistry,
    targetToken,
    `
      mutation GenerateUploadUrl($input: GenerateUploadUrlInput!) {
        generateUploadUrl(input: $input) {
          signedUrl {
            url
          }
        }
      }
    `,
    {
      input: {
        name: pkg.resolvedName,
        version: pkg.resolvedVersion,
        filename: `${name}-${pkg.resolvedVersion}.webc`,
      },
    },
  );
  const signedUrl = upload.generateUploadUrl?.signedUrl?.url;
  if (typeof signedUrl !== "string" || !signedUrl) {
    throw new Error(
      `generateUploadUrl did not return a signed URL for ${pkg.resolvedName}@${pkg.resolvedVersion}`,
    );
  }

  await uploadPackageBytes(signedUrl, packagePath);

  const published = await graphql(
    targetRegistry,
    targetToken,
    `
      mutation PublishPackage($input: PublishPackageInput!) {
        publishPackage(input: $input) {
          success
          packageVersion {
            version
            package {
              globalName
            }
          }
        }
      }
    `,
    {
      input: {
        manifest: pkg.manifest,
        name,
        namespace,
        version: pkg.resolvedVersion,
        signedUrl,
        uploadFormat: "webcv3",
        wait: true,
      },
    },
  );

  if (published.publishPackage?.success !== true) {
    throw new Error(
      `publishPackage returned success=false for ${pkg.resolvedName}@${pkg.resolvedVersion}`,
    );
  }
}

async function downloadPackage(pkg) {
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const outputPath = path.join(cacheDir, safePackageFilename(pkg));
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    debug(`Using cached ${pkg.resolvedName}@${pkg.resolvedVersion}`);
    return outputPath;
  }

  const tempPath = `${outputPath}.${crypto.randomUUID()}.tmp`;
  log(
    `Downloading ${pkg.resolvedName}@${pkg.resolvedVersion} from ${sourceRegistry} to ${tempPath}`,
  );
  await appendDownloadLog(
    `$ wasmer package download ${pkg.resolvedName}@=${pkg.resolvedVersion} -o ${tempPath}`,
  );
  try {
    await runWasmer(
      [
        "package",
        "download",
        `${pkg.resolvedName}@=${pkg.resolvedVersion}`,
        "-o",
        tempPath,
      ],
      {
        WASMER_REGISTRY: sourceRegistry,
        // Do not leak the disposable local-registry WASMER_TOKEN into source
        // package downloads. Public packages should be fetched anonymously unless
        // LOCAL_PLATFORM_PACKAGE_SOURCE_TOKEN is explicitly provided.
        WASMER_TOKEN: sourceToken ?? "",
        RUST_LOG: process.env.LOCAL_PLATFORM_WASMER_DOWNLOAD_RUST_LOG ?? "info",
      },
    );
  } catch (err) {
    let tempPathStatus = "missing";
    try {
      const stat = await fs.promises.stat(tempPath);
      tempPathStatus = `exists size=${stat.size}`;
    } catch {
      // keep missing
    }
    const detail = `${err.message}\ntempPath: ${tempPathStatus}\ncacheDir: ${cacheDir}`;
    await appendDownloadLog(detail);
    throw new Error(detail);
  }
  await fs.promises.rename(tempPath, outputPath);
  return outputPath;
}

async function seedPackage(pkg) {
  if (await targetHasPackage(pkg)) {
    log(`Already seeded ${pkg.resolvedName}@${pkg.resolvedVersion}`);
    return { ...pkg, seeded: false, skippedReason: "already-present" };
  }

  const packagePath = await downloadPackage(pkg);
  const [namespace, name] = pkg.resolvedName.split("/");
  await ensureTargetNamespace(namespace);
  log(
    `Publishing ${pkg.resolvedName}@${pkg.resolvedVersion} into local registry`,
  );
  try {
    await publishPackage(pkg, namespace, name, packagePath);
  } catch (err) {
    if (!String(err?.message ?? err).includes("Expected a webc v3")) {
      throw err;
    }
    const rebuiltPath = await rebuildPackageAsWebcV3(pkg, packagePath);
    await publishPackage(pkg, namespace, name, rebuiltPath);
  }

  return { ...pkg, seeded: true };
}

async function main() {
  const discovered = await discoverRequirements();
  if (discovered.length === 0) {
    log("No package dependencies discovered");
    return;
  }

  log(`Source registry: ${sourceRegistry}`);
  log(
    sourceToken
      ? "Using explicit source registry token from LOCAL_PLATFORM_PACKAGE_SOURCE_TOKEN"
      : "No source registry token configured; source package downloads are anonymous",
  );
  log(
    `Discovered ${discovered.length} package requirement(s): ${discovered
      .map((pkg) => `${pkg.name}@${pkg.constraint}`)
      .join(", ")}`,
  );

  const wasmerVersion = (await runWasmer(["--version"], {})).stdout.trim();
  log(`Wasmer CLI: ${wasmerVersion || "unknown version"}`);

  const resolved = await resolveAllRequirements(discovered);
  log(
    `Resolved ${resolved.length} package version(s): ${resolved
      .map((pkg) => `${pkg.resolvedName}@${pkg.resolvedVersion}`)
      .join(", ")}`,
  );

  const results = [];
  latestDiagnostics = {
    sourceRegistry,
    targetRegistry,
    directRefNamespaceAllowlist: [...directRefNamespaceAllowlist],
    scanDirs,
    seedFile,
    wasmerVersion,
    discovered,
    resolved,
    results,
  };
  await writeDiagnostics();
  if (dryRun) {
    log("Dry run enabled; not pushing packages into the target registry");
    for (const pkg of resolved) {
      results.push({ ...pkg, seeded: false, skippedReason: "dry-run" });
      await writeDiagnostics();
    }
  } else {
    for (const pkg of resolved) {
      results.push(await seedPackage(pkg));
      await writeDiagnostics();
    }
  }

  await writeDiagnostics();

  const seededCount = results.filter((pkg) => pkg.seeded).length;
  if (dryRun) {
    log(
      `Package seed dry run complete: ${results.length} package(s) would be checked/pushed`,
    );
  } else {
    log(
      `Package seed complete: ${seededCount} pushed, ${results.length - seededCount} already present`,
    );
  }
}

main().catch(async (err) => {
  console.error(`[package-seed] ERROR: ${err.message}`);
  try {
    await writeDiagnostics({ error: String(err?.message ?? err) });
  } catch (diagnosticErr) {
    console.error(
      `[package-seed] ERROR: failed to write diagnostics: ${diagnosticErr.message}`,
    );
  }
  process.exitCode = 1;
});
