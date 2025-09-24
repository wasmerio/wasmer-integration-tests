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
