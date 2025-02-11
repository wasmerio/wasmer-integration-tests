import * as path from "node:path";
import os from "node:os";
import fs from "node:fs";
import * as toml from "jsr:@std/toml";

import { Path } from "./fs.ts";

// The global wasmer config file.
export interface WasmerConfig {
  registry?: {
    active_registry?: string;
    tokens?: [{ registry: string; token: string }];
  };
}

// Load the wasmer CLI config file.
export function loadWasmerConfig(): WasmerConfig {
  const p = path.join(os.homedir(), ".wasmer/wasmer.toml");
  const contents = fs.readFileSync(p, "utf-8");
  const data = toml.parse(contents);
  return data;
}

// Parsed output from the "wasmer deploy" command.
export interface DeployOutput {
  name: string;
  appId: string;
  appVersionId: string;
  url: string;

  path: Path;
}

export function parseDeployOutput(stdout: string, dir: Path): DeployOutput {
  let infoRaw: any;
  try {
    infoRaw = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `Invalid output data: could not parse output as JSON: '${err}': '${stdout}'`,
    );
  }

  let jsonConfig: any;
  try {
    jsonConfig = JSON.parse(infoRaw?.json_config);
  } catch (err) {
    throw new Error(
      `Invalid output data: could not parse JSON config: '${err}': '${infoRaw?.jsonConfig}'`,
    );
  }

  const fullName = jsonConfig?.meta?.name;
  if (typeof fullName !== "string") {
    throw new Error(
      `Invalid output data: could not extract name from JSON config: '${infoRaw?.jsonConfig}'`,
    );
  }
  const [_owner, name] = fullName.split("/");

  if (typeof infoRaw !== "object") {
    throw new Error(
      `Invalid output data: expected JSON object, got '${stdout}'`,
    );
  }

  const versionId = infoRaw?.id;
  if (typeof versionId !== "string") {
    throw new Error(
      `Invalid output data: could not extract ID from '${stdout}'`,
    );
  }

  const appId = infoRaw?.app?.id;
  if (typeof appId !== "string") {
    throw new Error(
      `Invalid output data: could not extract app ID from '${stdout}'`,
    );
  }

  const url = infoRaw?.url;
  if (typeof url !== "string" || !url.startsWith("http")) {
    throw new Error(
      `Invalid output data: could not extract URL from '${stdout}'`,
    );
  }

  const info: DeployOutput = {
    name,
    appId,
    appVersionId: versionId,
    url,
    path: dir,
  };

  return info;
}
