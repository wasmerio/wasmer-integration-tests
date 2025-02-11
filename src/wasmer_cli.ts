import * as path from "node:path";
import os from "node:os";
import fs from "node:fs";
import * as toml from "jsr:@std/toml";

import { z } from "zod";
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

const deployOutputSchema = z.object({
  json_config: z.string(),
  id: z.string(),
  app: z.object({
    id: z.string(),
  }),
  url: z.string().refine((val) => val.startsWith("http"), {
    message: "Invalid URL format",
  }),
});

export function parseDeployOutput(stdout: string, dir: Path): DeployOutput {
  const parsedData = deployOutputSchema.parse(stdout);

  const jsonConfig = JSON.parse(parsedData.json_config);
  const fullName = jsonConfig?.meta?.name;
  if (typeof fullName !== "string") {
    throw new Error(
      `Invalid output data: could not extract name from JSON config: '${parsedData.json_config}'`,
    );
  }

  const [_owner, name] = fullName.split("/");

  return {
    name,
    appId: parsedData.app.id,
    appVersionId: parsedData.id,
    url: parsedData.url,
    path: dir,
  };
}
