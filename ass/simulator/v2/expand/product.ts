// Product-axis expansion: identity, apps, versions, custom domains,
// volumes, databases, cronjob definitions. Pure - the only reason this
// file knows an app has a "namespace" is that the declaration says so.

import { id, resource, type Resource } from "../model";
import { parseSizeBytes } from "../../schema";
import type {
  AppSpec,
  AppVersionSpec,
  CronjobSpec,
  DatabaseSpec,
  DomainSpec,
  NamespaceSpec,
  UserSpec,
  VolumeSpec,
} from "../specs";
import { subresourceApps, type World, type WorldApp } from "./world";

/** Identity is retained on teardown when the account is pinned - v1's
 * superuser lens, spelled as a resource policy. */
export function* expandIdentity(world: World): Generator<Resource> {
  const prune = world.pinned ? "retain" : "delete";
  const userId = id("user", world.username);
  yield resource<UserSpec>({
    id: userId,
    spec: {
      username: world.username,
      email: `${world.username}@simulated.local`,
      password: world.password,
    },
    policy: { prune },
    fingerprintOf: { username: world.username },
  });
  yield resource<NamespaceSpec>({
    id: id("namespace", world.namespace),
    spec: { name: world.namespace, owner: world.username },
    deps: [userId],
    policy: { prune },
  });
}

function appsSorted(world: World): WorldApp[] {
  return [...world.apps].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

export function* expandApps(world: World): Generator<Resource> {
  const namespaceId = id("namespace", world.namespace);
  for (const app of appsSorted(world)) {
    const stream = world.random.fork(`app-age-${app.name}`);
    yield resource<AppSpec>({
      id: id("app", world.namespace, app.name),
      spec: {
        namespace: world.namespace,
        name: app.name,
        fixture: app.fixture,
        ageDays:
          app.realism === "deployed" ? 0 : 30 + Math.round(stream.next() * 370),
      },
      deps: [namespaceId],
      policy: { prune: "delete", realism: app.realism },
      // Age is cosmetic history; realism and identity are what a diff acts on.
      fingerprintOf: {
        namespace: world.namespace,
        name: app.name,
        realism: app.realism,
      },
    });
  }
}

export function* expandVersions(world: World): Generator<Resource> {
  const perApp = world.declaration.apps?.deployments?.perApp ?? 1;
  const failed = world.declaration.apps?.deployments?.failed ?? 0;
  for (const app of appsSorted(world)) {
    const appId = id("app", world.namespace, app.name);
    const stream = world.random.fork(`versions-${app.name}`);
    for (let version = 1; version <= perApp; version++) {
      const isFailed = version > perApp - failed;
      const active = !isFailed && version === lastSuccessful(perApp, failed);
      yield resource<AppVersionSpec>({
        id: id(
          "app-version",
          world.namespace,
          app.name,
          String(version).padStart(4, "0"),
        ),
        spec: {
          namespace: world.namespace,
          app: app.name,
          version,
          active,
          failed: isFailed,
          ageDays: Math.round(stream.next() * 28 * 10) / 10,
        },
        deps: [appId],
        policy: {
          prune: "delete",
          // Version 1 of a really-deployed app is created by the deploy itself.
          realism:
            app.realism === "deployed" && version === 1
              ? "deployed"
              : "fabricated",
        },
        fingerprintOf: { app: app.name, version, active, failed: isFailed },
      });
    }
  }
}

function lastSuccessful(perApp: number, failed: number): number {
  return Math.max(1, perApp - failed);
}

export function* expandDomains(world: World): Generator<Resource> {
  const custom = world.declaration.apps?.domains?.custom ?? 0;
  const apps = appsSorted(world);
  if (custom === 0 || apps.length === 0) {
    return;
  }
  const emitted: Array<{ app: WorldApp; fqdn: string }> = [];
  for (let index = 0; index < custom; index++) {
    const app = world.apps[index % world.apps.length];
    // Alias text is globally unique in the backend, so the workspace is
    // part of the name: two scenarios sharing a seed (and therefore app
    // names) would otherwise collide on their custom domains.
    emitted.push({
      app,
      fqdn: `${app.name}.example-${index + 1}.${world.namespace}.test`,
    });
  }
  emitted.sort((a, b) =>
    a.app.name === b.app.name
      ? a.fqdn < b.fqdn
        ? -1
        : 1
      : a.app.name < b.app.name
        ? -1
        : 1,
  );
  for (const entry of emitted) {
    yield resource<DomainSpec>({
      id: id("domain", world.namespace, entry.app.name, entry.fqdn),
      spec: {
        namespace: world.namespace,
        app: entry.app.name,
        fqdn: entry.fqdn,
        kind: "custom",
      },
      deps: [id("app", world.namespace, entry.app.name)],
    });
  }
}

export function* expandVolumes(world: World): Generator<Resource> {
  const block = world.declaration.apps?.volumes;
  if (block === undefined) {
    return;
  }
  for (const app of subresourceApps(world, block.apps).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    for (let index = 0; index < block.perApp; index++) {
      const mountPath =
        index === 0 ? block.mountPath : `${block.mountPath}-${index + 1}`;
      yield resource<VolumeSpec>({
        id: id("volume", world.namespace, app.name, mountPath),
        spec: {
          namespace: world.namespace,
          app: app.name,
          mountPath,
          maxSizeBytes: parseSizeBytes(block.maxSize),
        },
        deps: [id("app", world.namespace, app.name)],
      });
    }
  }
}

export function* expandDatabases(world: World): Generator<Resource> {
  const block = world.declaration.apps?.databases;
  if (block === undefined) {
    return;
  }
  for (const app of subresourceApps(world, block.apps).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    for (let index = 0; index < block.perApp; index++) {
      const name = index === 0 ? block.name : `${block.name}_${index + 1}`;
      yield resource<DatabaseSpec>({
        id: id("database", world.namespace, app.name, name),
        spec: { namespace: world.namespace, app: app.name, name },
        deps: [id("app", world.namespace, app.name)],
      });
    }
  }
}

export function* expandCronjobs(world: World): Generator<Resource> {
  const block = world.declaration.apps?.cronjobs;
  if (block === undefined) {
    return;
  }
  for (const app of subresourceApps(world, block.apps).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    for (let index = 0; index < block.perApp; index++) {
      const name = index === 0 ? block.name : `${block.name}-${index + 1}`;
      yield resource<CronjobSpec>({
        id: id("cronjob", world.namespace, app.name, name),
        spec: {
          namespace: world.namespace,
          app: app.name,
          name,
          schedule: block.schedule,
          kind: block.kind,
          enabled: block.enabled,
          path: block.path,
          method: block.method,
        },
        deps: [id("app", world.namespace, app.name)],
      });
    }
  }
}
