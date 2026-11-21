// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * PostgreSQL access (RDS for PostgreSQL / RDS Supabase, or GaussDB).
 *
 * A function instance is short-lived and many instances share one database, so
 * the pool stays small and is created per process. `BIGINT` arrives as a number
 * (ids and milli-credit amounts stay far below 2^53), which keeps the JSON the
 * clients and the admin page see free of stringly-typed numbers.
 *
 * Behind Supabase's Supavisor pooler keep `ACCOUNTS_POOL_SIZE` at 2-3: the
 * smallest plan allows 100 client connections and Supabase itself already holds
 * 40-50 of them, so a large per-instance pool multiplied by function concurrency
 * runs the pool dry.
 */

import { Pool, types, type PoolClient, type QueryResultRow } from "pg";

// int8 (OID 20). Credit balances are milli-credits; realistic values are tiny.
types.setTypeParser(20, (value: string) => Number(value));

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<T[]>;
}

export class Database implements Queryable {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: Number(process.env.ACCOUNTS_POOL_SIZE ?? 5), idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query<T>(sql, values);
    return result.rows;
  }

  /** Runs `work` inside BEGIN/COMMIT, rolling back on any throw. */
  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work({
        query: async <R extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) => {
          const result = await client.query<R>(sql, values);
          return result.rows;
        },
      });
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
