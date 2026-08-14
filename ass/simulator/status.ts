// `ass status`: the held state made inspectable. Informational only — exit
// 0 whether or not anything is held and whether or not the platform serves
// (the platform layer's exit-1-when-down is a documented trap this verb
// deliberately does not copy). `--json` is the stable machine surface
// consumed by scripts/local-dev.sh.

import { LocalPlatformDriver } from "../fixtures/localPlatform";
import { EXIT_OK } from "../engine/assessment";
import { listLedgers, type LedgerFile } from "./ledger";
import { heldLockHolder } from "./lock";
import { platformIsLive } from "./platform";
import type { SimulatorIo } from "./engine/context";
import type { SimulatorDeps } from "./deps";

/** Domain facts for a held scenario, so verifying seeded state needs no
 * backend schema knowledge (agentic-trial-0 gap 5): the workspace and its
 * live app count straight from the backend the dashboard reads. */
export interface WorkspaceFacts {
  namespace: string;
  /** null when the backend could not be queried (never a guess). */
  apps: number | null;
}

async function workspaceFacts(
  env: Record<string, string>,
  ledger: LedgerFile,
): Promise<WorkspaceFacts | null> {
  const namespace = ledger.declaration?.account?.namespace;
  if (typeof namespace !== "string" || namespace === "") {
    return null;
  }
  try {
    const { SimulatorBackend } = await import("./clients/graphql");
    const backend = new SimulatorBackend(
      env["WASMER_REGISTRY"],
      env["WASMER_TOKEN"] ?? null,
    );
    const data = await backend.gql<{
      getNamespace: { apps: { totalCount: number | null } | null } | null;
    }>(
      `query($n: String!) { getNamespace(name: $n) { apps(first: 1) { totalCount } } }`,
      { n: namespace },
    );
    const total = data.getNamespace?.apps?.totalCount;
    return { namespace, apps: typeof total === "number" ? total : null };
  } catch {
    return { namespace, apps: null };
  }
}

export interface StatusOptions {
  json?: boolean;
  cwd: string;
  io: SimulatorIo;
  deps?: SimulatorDeps;
}

interface EntryCounts {
  [kind: string]: { done: number; total: number };
}

/** The documented `--json` shape. Additive changes only. */
export interface StatusJson {
  held: Array<{
    slug: string;
    scenarioPath: string;
    seed: number;
    heldAt: string;
    ageSeconds: number;
    completed: boolean;
    ownsPlatform: boolean;
    entries: EntryCounts;
    doneEntries: number;
    totalEntries: number;
    /** Present when the platform is live and the scenario has an account:
     * the workspace name and its current app count from backend GraphQL. */
    workspace?: WorkspaceFacts;
  }>;
  corrupt: Array<{ path: string; error: string }>;
  platform: { live: boolean; registry: string | null };
  /** Non-null while an `ass up` is running: an in-flight reconcile's hold
   * reads `completed: false`, which is otherwise indistinguishable from a
   * crash. */
  seeding: { pid: number } | null;
}

function countEntries(
  teardown: ReadonlyArray<{ kind: string; done?: boolean }>,
): EntryCounts {
  const counts: EntryCounts = {};
  for (const entry of teardown) {
    counts[entry.kind] ??= { done: 0, total: 0 };
    counts[entry.kind].total += 1;
    if (entry.done === true) {
      counts[entry.kind].done += 1;
    }
  }
  return counts;
}

function humanAge(seconds: number): string {
  if (seconds < 90) {
    return `${Math.max(0, Math.round(seconds))}s`;
  }
  if (seconds < 5400) {
    return `${Math.round(seconds / 60)}m`;
  }
  if (seconds < 129_600) {
    return `${Math.round(seconds / 3600)}h`;
  }
  return `${Math.round(seconds / 86_400)}d`;
}

export async function runStatus(options: StatusOptions): Promise<number> {
  const { io } = options;
  const driver =
    options.deps?.driver ??
    new LocalPlatformDriver(options.cwd, {
      io: { info: () => undefined },
    });
  const repoDir = driver.repoDir;
  const now = options.deps?.now ?? (() => Date.now());

  const listing = listLedgers(repoDir);
  const env = await platformIsLive(driver, options.deps?.fetchImpl);

  const json: StatusJson = {
    held: await Promise.all(
      listing.ledgers.map(async (ledger) => {
        const counts = countEntries(ledger.teardown);
        const totals = ledger.teardown.length;
        const done = ledger.teardown.filter(
          (entry) => entry.done === true,
        ).length;
        const workspace =
          env !== null ? await workspaceFacts(env, ledger) : null;
        return {
          slug: ledger.slug,
          scenarioPath: ledger.scenarioPath,
          seed: ledger.seed,
          heldAt: ledger.heldAt,
          ageSeconds: Math.max(
            0,
            Math.round((now() - Date.parse(ledger.heldAt)) / 1000),
          ),
          completed: ledger.completedAt !== null,
          ownsPlatform: ledger.ownsPlatform,
          entries: counts,
          doneEntries: done,
          totalEntries: totals,
          ...(workspace !== null ? { workspace } : {}),
        };
      }),
    ),
    corrupt: listing.corrupt,
    platform: {
      live: env !== null,
      registry: env?.["WASMER_REGISTRY"] ?? null,
    },
    seeding: (() => {
      const pid = heldLockHolder(repoDir);
      return pid === null ? null : { pid };
    })(),
  };

  if (options.json === true) {
    io.out(JSON.stringify(json, null, 2));
    return EXIT_OK;
  }

  if (json.seeding !== null) {
    io.out(
      `seeding: in progress (pid ${json.seeding.pid}) — an ass up is running`,
    );
  }
  if (json.held.length === 0) {
    io.out("held scenarios: none");
  }
  for (const held of json.held) {
    const state = held.completed
      ? ""
      : json.seeding !== null
        ? ", seeding now"
        : ", INCOMPLETE — crashed";
    io.out(
      `held: ${held.slug} (seed ${held.seed}, ${humanAge(held.ageSeconds)} ` +
        `ago${state}${held.ownsPlatform ? ", owns platform" : ""})`,
    );
    io.out(`  scenario: ${held.scenarioPath}`);
    const parts = Object.entries(held.entries).map(
      ([kind, count]) => `${kind} ${count.done}/${count.total}`,
    );
    io.out(
      `  teardown entries: ${parts.length > 0 ? parts.join(", ") : "none"}`,
    );
    if (held.workspace !== undefined) {
      io.out(
        `  workspace: ${held.workspace.namespace} — ` +
          (held.workspace.apps !== null
            ? `${held.workspace.apps} apps`
            : "app count unavailable"),
      );
    }
  }
  for (const corrupt of listing.corrupt) {
    io.out(`corrupt descriptor: ${corrupt.path}`);
  }
  io.out(
    json.platform.live
      ? `platform: serving (${json.platform.registry})`
      : "platform: not serving",
  );
  return EXIT_OK;
}
