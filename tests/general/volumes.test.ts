// Volume tests
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, createHmac } from "node:crypto";

import { assertEquals } from "../../src/testing_tools";

import { copyPackageAnonymous } from "../../src/package";
import { randomAppName } from "../../src/app/construct";
import { projectRoot } from "../utils/path";
import { sleep } from "../../src/util";

import {
  AppDefinition,
  buildJsWorkerApp,
  HEADER_INSTANCE_ID,
  HEADER_PURGE_INSTANCES,
  TestEnv,
  writeAppDefinition,
} from "../../src/index";

interface AppVolumeNode {
  id: string;
  volumeId: string;
  mountPath: string;
  s3Enabled: boolean;
  s3: S3Credentials | null;
}

interface S3Credentials {
  endpoint: string;
  accessKey: string;
  secretKey: string;
}

async function getAppVolumes(
  env: TestEnv,
  appId: string,
): Promise<AppVolumeNode[]> {
  const res = await env.backend.gqlQuery<{
    node: {
      volumes: {
        edges: Array<{ node: AppVolumeNode }>;
      };
    };
  }>(
    `
      query AppVolumes($id: ID!) {
        node(id: $id) {
          ... on DeployApp {
            volumes {
              edges {
                node {
                  id
                  volumeId
                  mountPath
                  s3Enabled
                  s3 {
                    endpoint
                    accessKey
                    secretKey
                  }
                }
              }
            }
          }
        }
      }
    `,
    { id: appId },
  );
  return res.data!.node.volumes.edges.map((edge) => edge.node);
}

async function getSingleAppVolume(
  env: TestEnv,
  appId: string,
): Promise<AppVolumeNode> {
  const volumes = await getAppVolumes(env, appId);
  expect(volumes).toHaveLength(1);
  return volumes[0];
}

async function enableVolumeS3(
  env: TestEnv,
  volumeId: string,
): Promise<AppVolumeNode> {
  const res = await env.backend.gqlQuery<{
    updateVolume: {
      success: boolean;
      volume: AppVolumeNode;
    };
  }>(
    `
      mutation EnableVolumeS3($id: ID!) {
        updateVolume(input: { id: $id, s3Enabled: true }) {
          success
          volume {
            id
            volumeId
            mountPath
            s3Enabled
            s3 {
              endpoint
              accessKey
              secretKey
            }
          }
        }
      }
    `,
    { id: volumeId },
  );
  expect(res.data!.updateVolume.success).toBe(true);
  return res.data!.updateVolume.volume;
}

async function rotateVolumeS3Credentials(
  env: TestEnv,
  volumeId: string,
): Promise<S3Credentials> {
  const res = await env.backend.gqlQuery<{
    rotateS3Credentials: S3Credentials & { success: boolean };
  }>(
    `
      mutation RotateVolumeS3Credentials($id: ID!) {
        rotateS3Credentials(input: { id: $id }) {
          success
          endpoint
          accessKey
          secretKey
        }
      }
    `,
    { id: volumeId },
  );
  expect(res.data!.rotateS3Credentials.success).toBe(true);
  return res.data!.rotateS3Credentials;
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function encodeS3PathPart(part: string): string {
  return encodeURIComponent(part).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildS3ObjectUrl(
  credentials: S3Credentials,
  bucket: string,
  key: string,
): URL {
  const url = new URL(credentials.endpoint);
  const keyPath = key
    .split("/")
    .filter((part) => part.length > 0)
    .map(encodeS3PathPart)
    .join("/");
  url.pathname = `/${encodeS3PathPart(bucket)}/${keyPath}`;
  return url;
}

async function signedS3Request(
  credentials: S3Credentials,
  bucket: string,
  key: string,
  options: { method: "GET" | "PUT"; body?: string },
): Promise<Response> {
  const url = buildS3ObjectUrl(credentials, bucket, key);
  const payload = options.body ?? "";
  const payloadHash = sha256Hex(payload);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "us-east-1";
  const service = "s3";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const host = url.host;
  const canonicalHeaders = [
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
  ].join("\n");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    options.method,
    url.pathname,
    "",
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = hmacSha256(
    hmacSha256(
      hmacSha256(hmacSha256(`AWS4${credentials.secretKey}`, dateStamp), region),
      service,
    ),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");

  return fetch(url, {
    method: options.method,
    body: options.body,
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  });
}

async function readS3ObjectWithRetry(
  credentials: S3Credentials,
  bucket: string,
  key: string,
): Promise<string> {
  let lastBody = "";
  let lastStatus = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await signedS3Request(credentials, bucket, key, {
      method: "GET",
    });
    lastStatus = response.status;
    lastBody = await response.text();
    if (response.ok) {
      return lastBody;
    }
    await sleep(2500);
  }
  throw new Error(
    `Failed to read S3 object ${bucket}/${key}: HTTP ${lastStatus}: ${lastBody}`,
  );
}

function expectNonEmptyBucketEnvVar(
  bucketEnv: Record<string, string>,
  predicate: (name: string) => boolean,
  description: string,
): void {
  const names = Object.keys(bucketEnv).sort();
  const name = names.find(predicate);
  if (!name) {
    throw new Error(
      `Expected ${description} BUCKET_ env var to be set. Found: ${names.join(", ")}`,
    );
  }

  expect(bucketEnv[name]).toEqual(expect.any(String));
  expect(bucketEnv[name].length).toBeGreaterThan(0);
}

test("app-volume-exposes-bucket-env-vars", async () => {
  const env = TestEnv.fromEnv();
  const code = `
async function handler() {
  const bucketEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("BUCKET_")),
  );
  const envNames = Object.keys(process.env).sort();
  return new Response(JSON.stringify({ bucketEnv, envNames }), {
    headers: { "content-type": "application/json" },
  });
}

addEventListener("fetch", (fetchEvent) => {
  fetchEvent.respondWith(handler());
});
`;

  const spec = buildJsWorkerApp(code);
  spec.appYaml.debug = true;
  spec.appYaml.volumes = [
    {
      name: "data",
      mount: "/data",
    },
  ];

  const info = await env.deployApp(spec);
  const response = await env.fetchApp(info, "/", {
    headers: {
      [HEADER_PURGE_INSTANCES]: "1",
    },
  });
  const body = await response.text();
  const data = JSON.parse(body) as {
    bucketEnv?: Record<string, string>;
    envNames?: string[];
  };
  const bucketEnv = data.bucketEnv ?? {};
  const bucketEnvNames = Object.keys(bucketEnv).sort();

  if (bucketEnvNames.length === 0) {
    throw new Error(
      `Expected app with volume to expose BUCKET_ env vars, but none were present. Exposed env var names: ${(data.envNames ?? []).join(", ")}`,
    );
  }
  expectNonEmptyBucketEnvVar(
    bucketEnv,
    (name) => name.includes("ACCESS") && name.includes("KEY"),
    "bucket access key",
  );
  expectNonEmptyBucketEnvVar(
    bucketEnv,
    (name) => name.includes("SECRET") && name.includes("KEY"),
    "bucket secret key",
  );

  await env.deleteApp(info);
});

test("app-volumes", async () => {
  const env = TestEnv.fromEnv();

  const rootPackageDir = path.join(
    projectRoot,
    "wasmopticon",
    "php",
    "php-testserver",
  );
  const dir = await copyPackageAnonymous(rootPackageDir);

  const app: AppDefinition = {
    appYaml: {
      kind: "wasmer.io/App.v0",
      name: randomAppName(),
      owner: env.namespace,
      package: ".",
      // Enable debug mode to allow instance purging.
      debug: true,
      volumes: [
        {
          name: "data",
          mount: "/data",
        },
      ],
    },
  };
  writeAppDefinition(dir, app);

  const info = await env.deployAppDir(dir);

  const file1Content = "value1";

  // Write a file to the volume.
  await env.fetchApp(info, "/fs/write/data/file1", {
    method: "POST",
    body: file1Content,
    discardBody: true,
  });

  // Read the file.
  {
    const resp = await env.fetchApp(info, "/fs/read/data/file1");
    const body = await resp.text();
    assertEquals(body, file1Content);
  }

  // Now read again, but force a fresh instance to make sure it wasn't just
  // stored in memory.
  {
    const resp = await env.fetchApp(info, "/fs/read/data/file1", {
      headers: {
        [HEADER_PURGE_INSTANCES]: "1",
      },
    });
    const body = await resp.text();
    assertEquals(body, file1Content);
  }
  await env.deleteApp(info);
});

test("app-volume-survives-redeploy-with-refreshed-s3-credentials", async () => {
  const env = TestEnv.fromEnv();

  const rootPackageDir = path.join(
    projectRoot,
    "wasmopticon",
    "php",
    "php-testserver",
  );
  const dir = await copyPackageAnonymous(rootPackageDir);
  const appName = randomAppName();

  const app: AppDefinition = {
    appYaml: {
      kind: "wasmer.io/App.v0",
      name: appName,
      owner: env.namespace,
      package: ".",
      // Enable debug mode to allow instance purging after redeploy.
      debug: true,
      volumes: [
        {
          name: "data",
          mount: "/data",
        },
      ],
    },
  };
  await writeAppDefinition(dir, app);

  const info = await env.deployAppDir(dir);
  const initialVolume = await getSingleAppVolume(env, info.id);
  expect(initialVolume.mountPath).toBe("/data");

  const s3EnabledVolume = await enableVolumeS3(env, initialVolume.id);
  expect(s3EnabledVolume.volumeId).toBe(initialVolume.volumeId);
  expect(s3EnabledVolume.s3Enabled).toBe(true);
  expect(s3EnabledVolume.s3).toBeTruthy();

  const fileKey = `redeploy-${crypto.randomUUID()}.txt`;
  const filePath = `/data/${fileKey}`;
  const fileContent = `persistent volume content ${crypto.randomUUID()}`;

  // Write a file through the mounted volume.
  await env.fetchApp(info, `/fs/write${filePath}`, {
    method: "POST",
    body: fileContent,
    discardBody: true,
  });

  // Verify the same bytes through the S3 view before redeploying. This makes
  // sure the credentials point at the currently attached AppVolume bucket.
  await expect(
    readS3ObjectWithRetry(s3EnabledVolume.s3!, initialVolume.volumeId, fileKey),
  ).resolves.toBe(fileContent);

  // Force a new deploy/version for the same app. The file is intentionally
  // outside the volume mount; it only makes the package input visibly change.
  await fs.promises.writeFile(
    path.join(dir, "app", "redeploy-marker.txt"),
    crypto.randomUUID(),
  );
  const redeployedInfo = await env.deployAppDir(dir);
  expect(redeployedInfo.id).toBe(info.id);

  const redeployedVolume = await getSingleAppVolume(env, info.id);
  expect(redeployedVolume.mountPath).toBe("/data");
  expect(redeployedVolume.volumeId).toBe(initialVolume.volumeId);

  // Rotate credentials after redeploy and use the fresh credentials to verify
  // the bucket attached to the new version still contains the file.
  const refreshedCredentials = await rotateVolumeS3Credentials(
    env,
    redeployedVolume.id,
  );
  await expect(
    readS3ObjectWithRetry(
      refreshedCredentials,
      redeployedVolume.volumeId,
      fileKey,
    ),
  ).resolves.toBe(fileContent);

  // Also verify through a fresh app instance so the result cannot come from an
  // old in-memory process that survived the redeploy.
  const resp = await env.fetchApp(redeployedInfo, `/fs/read${filePath}`, {
    headers: {
      [HEADER_PURGE_INSTANCES]: "1",
    },
  });
  const body = await resp.text();
  assertEquals(body, fileContent);

  await env.deleteApp(redeployedInfo);
});

// Test that a volume can be mounted inside a directory mounted from a package.
test("volume-mount-inside-package-dir", async () => {
  const env = TestEnv.fromEnv();

  const rootPackageDir = path.join(
    projectRoot,
    "wasmopticon",
    "php",
    "php-testserver",
  );
  const dir = await copyPackageAnonymous(rootPackageDir);

  // The PHP testserver mounts code at /app, so we'll mount a volume inside that.

  const app: AppDefinition = {
    appYaml: {
      kind: "wasmer.io/App.v0",
      name: randomAppName(),
      owner: env.namespace,
      package: ".",
      // Enable debug mode to allow instance purging.
      debug: true,
      volumes: [
        {
          name: "data",
          mount: "/app/data",
        },
      ],
    },
  };
  writeAppDefinition(dir, app);

  const info = await env.deployAppDir(dir);

  const file1Content = "value1";

  const filePath = "/app/data/file1";

  // Write a file to the volume.
  await env.fetchApp(info, `/fs/write${filePath}`, {
    method: "POST",
    body: file1Content,
    discardBody: true,
  });

  // Read the file.
  let firstInstanceId: string;
  {
    const resp = await env.fetchApp(info, `/fs/read${filePath}`);
    const body = await resp.text();
    assertEquals(body, file1Content);
    const id = resp.headers.get(HEADER_INSTANCE_ID);
    expect(id).toBeTruthy();
    firstInstanceId = id!;
  }
  expect(firstInstanceId).toBeTruthy();

  // Now read again, but force a fresh instance to make sure it wasn't just
  // stored in memory.
  {
    const resp = await env.fetchApp(info, `/fs/read${filePath}`, {
      headers: {
        [HEADER_PURGE_INSTANCES]: "1",
      },
    });
    const body = await resp.text();
    assertEquals(body, file1Content);

    const secondInstanceId = resp.headers.get(HEADER_INSTANCE_ID);
    expect(secondInstanceId).toBeTruthy();
    // Make sure the response was served from a different instance.
    expect(firstInstanceId).not.toBe(secondInstanceId);
  }
  await env.deleteApp(info);
});
