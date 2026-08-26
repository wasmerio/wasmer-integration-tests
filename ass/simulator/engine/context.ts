// What an adapter is handed: guarded store clients, the identity map, the
// lane semaphores and the deadline. Never a declaration, a seed or a
// scenario name - those live on the other side of the contract.

import { Pool, type PoolClient } from "pg";
import { guardedUrl } from "../guard";
import { SimulatorClickHouse } from "../clients/clickhouse";
import { SimulatorBackend } from "../clients/graphql";
import { IdentityMap } from "../identity";
import type { Lane } from "../model";

export interface SimulatorIo {
  out(line: string): void;
  err(line: string): void;
}

export interface WorkerWidths {
  global: number;
  sdk: number;
  clickhouse: number;
  postgres: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Math.round(value)));
}

function fromEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Section 9, knob table. `workers` is never a scenario key: concurrency
 * changes how fast a world is built, never what it is (invariant I6). */
export function resolveWorkers(
  flags: {
    workers?: number;
    workersSdk?: number;
    workersClickhouse?: number;
    workersPostgres?: number;
  },
  env: NodeJS.ProcessEnv = process.env,
  cpus = 8,
): WorkerWidths {
  const global = clamp(
    flags.workers ?? fromEnv(env, "SIM_WORKERS") ?? Math.min(8, cpus),
    1,
    64,
  );
  return {
    global,
    sdk: clamp(
      flags.workersSdk ?? fromEnv(env, "SIM_WORKERS_SDK") ?? global,
      1,
      32,
    ),
    clickhouse: clamp(
      flags.workersClickhouse ??
        fromEnv(env, "SIM_WORKERS_CLICKHOUSE") ??
        global,
      1,
      16,
    ),
    postgres: clamp(
      flags.workersPostgres ??
        fromEnv(env, "SIM_WORKERS_POSTGRES") ??
        Math.min(global, 8),
      1,
      16,
    ),
  };
}

export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly width: number) {
    this.available = width;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.available += 1;
  }
}

export interface EngineContext {
  env: Record<string, string>;
  io: SimulatorIo;
  verbose: boolean;
  identity: IdentityMap;
  clickhouse: SimulatorClickHouse;
  /** Guarded pool; adapters take a client per statement group. */
  postgres: Pool;
  /** Platform admin - account lifecycle, deletes. */
  admin: SimulatorBackend;
  /** The scenario user, once OBSERVE has minted a token. */
  user: SimulatorBackend | null;
  workers: WorkerWidths;
  lanes: Record<Lane, Semaphore>;
  /** Set by the scheduler so an adapter can address its own concurrency. */
  scenario: string;
  /** The scenario account. An engine input like the guarded endpoints -
   * adapters need it to act as the user, and it never reaches a plan. */
  credentials: { username: string; password: string };
  /** Wall-clock ceiling for the whole reconcile. */
  deadlineMs: number;
  withPostgres<T>(task: (client: PoolClient) => Promise<T>): Promise<T>;
}

export function createPostgresPool(
  env: Record<string, string>,
  width: number,
): Pool {
  const url = env["LOCAL_PLATFORM_POSTGRES_URL"];
  if (url === undefined || url.trim() === "") {
    throw new Error(
      "LOCAL_PLATFORM_POSTGRES_URL missing from the platform env - cannot " +
        "verify a loopback target, refusing to connect",
    );
  }
  return new Pool({
    connectionString: guardedUrl("LOCAL_PLATFORM_POSTGRES_URL", url),
    max: Math.max(2, width + 1),
    connectionTimeoutMillis: 15_000,
    query_timeout: 120_000,
  });
}

export function createContext(input: {
  env: Record<string, string>;
  io: SimulatorIo;
  verbose?: boolean;
  workers: WorkerWidths;
  identity?: IdentityMap;
  scenario: string;
  credentials: { username: string; password: string };
  deadlineMs?: number;
}): EngineContext {
  const pool = createPostgresPool(input.env, input.workers.postgres);
  const registry = input.env["WASMER_REGISTRY"];
  const token = input.env["WASMER_TOKEN"];
  if (registry === undefined || token === undefined) {
    throw new Error("test-env.sh exports no WASMER_REGISTRY/WASMER_TOKEN");
  }
  const context: EngineContext = {
    env: input.env,
    io: input.io,
    verbose: input.verbose === true,
    identity: input.identity ?? new IdentityMap(),
    clickhouse: new SimulatorClickHouse(input.env),
    postgres: pool,
    admin: new SimulatorBackend(registry, token),
    user: null,
    workers: input.workers,
    lanes: {
      sdk: new Semaphore(input.workers.sdk),
      clickhouse: new Semaphore(input.workers.clickhouse),
      postgres: new Semaphore(input.workers.postgres),
    },
    scenario: input.scenario,
    credentials: input.credentials,
    deadlineMs: input.deadlineMs ?? Date.now() + 30 * 60_000,
    async withPostgres(task) {
      const client = await pool.connect();
      try {
        return await task(client);
      } finally {
        client.release();
      }
    },
  };
  return context;
}

export async function closeContext(ctx: EngineContext): Promise<void> {
  await ctx.postgres.end().catch(() => undefined);
}

/** Bounded-concurrency map that preserves input order in its results -
 * invariant I6: results are collected by index, never completion order. */
export async function mapConcurrent<T, R>(
  items: T[],
  width: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(width, items.length)) }, () =>
      worker(),
    ),
  );
  return results;
}
