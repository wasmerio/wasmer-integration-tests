// Minimal ambient types for the `pg` client (the package ships no types and
// installing @types/pg currently trips the repo's pre-existing ERESOLVE
// conflict). Covers only the surface tests/utils/postgres.ts uses; delete
// this file if @types/pg is ever added.
declare module "pg" {
  export interface ClientConfig {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    connectionTimeoutMillis?: number;
    query_timeout?: number;
    ssl?: boolean | { rejectUnauthorized?: boolean };
  }

  export interface QueryResult {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows: any[];
    rowCount: number | null;
  }

  export class Client {
    constructor(config: ClientConfig);
    connect(): Promise<void>;
    end(): Promise<void>;
    query(text: string, values?: unknown[]): Promise<QueryResult>;
  }
}
