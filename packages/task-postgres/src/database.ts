import type { DatabaseConfig } from '@surfgate/config'
import { Pool, type PoolClient, type QueryResultRow } from 'pg'

export interface TaskQueryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<readonly Row[]>
}

export interface TaskDatabase extends TaskQueryable {
  transaction<Result>(operation: (transaction: TaskQueryable) => Promise<Result>): Promise<Result>
  close(): Promise<void>
}

class Queryable implements TaskQueryable {
  constructor(private readonly client: Pool | PoolClient) {}
  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    return (await this.client.query<Row>(text, [...values])).rows
  }
}

export function createTaskDatabase(config: Pick<DatabaseConfig, 'url'>): TaskDatabase {
  const pool = new Pool({
    connectionString: config.url.href,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 10,
    query_timeout: 6_000,
    statement_timeout: 5_000,
  })
  const queryable = new Queryable(pool)
  return Object.freeze({
    query: queryable.query.bind(queryable),
    async transaction<Result>(operation: (transaction: TaskQueryable) => Promise<Result>) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const result = await operation(new Queryable(client))
        await client.query('commit')
        return result
      } catch (error: unknown) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
    },
    async close(): Promise<void> {
      await pool.end()
    },
  })
}
