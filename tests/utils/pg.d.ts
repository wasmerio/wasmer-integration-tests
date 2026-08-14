// Minimal ambient types for the `pg` client (the package ships no types and
// installing @types/pg currently trips the repo's pre-existing ERESOLVE
// conflict). Covers only the surface tests/utils/postgres.ts and
// ass/simulator use; delete this file if @types/pg is ever added.
declare module "pg" {
  export interface ClientConfig {
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    connectionTimeoutMillis?: number;
    query_timeout?: number;
    ssl?: boolean | { rejectUnauthorized?: boolean };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export interface QueryResult<R = any> {
    rows: R[];
    rowCount: number | null;
  }

  export class Client {
    constructor(config: ClientConfig);
    connect(): Promise<void>;
    end(): Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query<R = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
  }

  export interface PoolConfig extends ClientConfig {
    max?: number;
    idleTimeoutMillis?: number;
  }

  /** A pooled client: the v2 engine's Postgres lane takes one per statement
   * group so its workers do not serialize on a single connection. */
  export interface PoolClient {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query<R = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    release(err?: Error | boolean): void;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query<R = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
  }
}
