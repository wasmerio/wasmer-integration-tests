import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as toml from "@iarna/toml";
import { env } from "node:process";
import { z } from "zod";
import { Path } from "./fs";

// The global wasmer config file.
export interface WasmerConfig {
  registry?: {
    active_registry?: string;
    tokens?: [{ registry: string; token: string }];
  };
}

// Load the wasmer CLI config file.
export function loadWasmerConfig(): WasmerConfig {
  const wasmer_dir = env.WASMER_DIR ?? path.join(os.homedir(), ".wasmer");
  const p = path.join(wasmer_dir, "wasmer.toml");
  const conte = fs.readFileSync(p, "utf-8");
  const data = toml.parse(conte);
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

const deployOutpchema = z.object({
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
  const parsedData = deployOutpchema.parse(JSON.parse(stdout));

  const jsonConfig = JSON.parse(parsedData.json_config);
  const fullName = jsonConfig?.meta?.name;
  if (typeof fullName !== "string") {
    throw new Error(
      `Invalid output data: could not extract name from JSON config: '${parsedData.json_config}'`,
    );
  }

  const [, name] = fullName.split("/");

  return {
    name,
    appId: parsedData.app.id,
    appVersionId: parsedData.id,
    url: parsedData.url,
    path: dir,
  };
}
