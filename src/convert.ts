import type { DeployApp } from "stackmachine";

import { AppGet } from "./app/appGet";
import { ApiDeployApp, AppInfo } from "./backend";
import { Path } from "./fs";
import { DeployOutput } from "./wasmer_cli";

export function appGetToAppInfo(appGet: AppGet): AppInfo {
  const version: DeployOutput = {
    name: appGet.name,
    appId: appGet.id,
    appVersionId: appGet.active_version.id,
    url: appGet.url,
    path: undefined as unknown as Path, // AppGet does not contain directory information
  };

  const app: ApiDeployApp = {
    id: appGet.id,
    url: appGet.url,
    permalink: appGet.permalink,
    activeVersionId: appGet.active_version.id,
  };

  return {
    version,
    app,
    id: appGet.id,
    url: appGet.url,
    dir: undefined as unknown as Path, // AppGet does not contain directory information
  };
}

// Structural subset of the StackMachine SDK `DeployApp` that is enough to
// identify an app for cleanup. Accepting the minimal shape (rather than the
// concrete class) lets partial/`*Like` app objects reuse this converter too.
export type DeployAppRef = Pick<DeployApp, "id" | "name" | "url"> & {
  activeVersion?: { id: string } | null;
};

/**
 * Build a minimal AppInfo from a StackMachine-SDK `DeployApp` so it can be fed
 * to the canonical cleanup path (`env.deleteApp` / `env.finalizeAppCleanup`),
 * exactly like apps deployed through the wasmer CLI. The SDK app carries no
 * local directory, so that is left empty.
 */
export function deployAppToAppInfo(app: DeployAppRef): AppInfo {
  const activeVersionId = app.activeVersion?.id ?? null;
  const version: DeployOutput = {
    name: app.name,
    appId: app.id,
    appVersionId: activeVersionId ?? "",
    url: app.url,
    path: "" as unknown as Path, // SDK deploys have no local directory
  };

  const apiApp: ApiDeployApp = {
    id: app.id,
    url: app.url,
    permalink: app.url,
    activeVersionId,
  };

  return {
    version,
    app: apiApp,
    id: app.id,
    url: app.url,
    dir: "" as unknown as Path,
  };
}
