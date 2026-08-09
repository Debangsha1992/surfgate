import type { DatabaseConfig } from '@surfgate/config'
import { Pool, type PoolClient, type QueryResultRow } from 'pg'

export interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<readonly Row[]>
}

export interface Database extends Queryable {
  health(): Promise<'ready' | 'unavailable'>
  transaction<Result>(operation: (transaction: Queryable) => Promise<Result>): Promise<Result>
  close(): Promise<void>
}

class PostgresQueryable implements Queryable {
  constructor(private readonly client: Pool | PoolClient) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    const result = await this.client.query<Row>(text, [...values])
    return result.rows
  }
}

class PostgresDatabase extends PostgresQueryable implements Database {
  constructor(private readonly pool: Pool) {
    super(pool)
  }

  async health(): Promise<'ready' | 'unavailable'> {
    try {
      await this.query('select 1')
      return 'ready'
    } catch {
      return 'unavailable'
    }
  }

  async transaction<Result>(
    operation: (transaction: Queryable) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const result = await operation(new PostgresQueryable(client))
      await client.query('commit')
      return result
    } catch (error: unknown) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

export function createDatabase(config: Pick<DatabaseConfig, 'url'>): Database {
  return new PostgresDatabase(
    new Pool({
      connectionString: config.url.href,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 10,
      maxLifetimeSeconds: 60 * 30,
      query_timeout: 6_000,
      statement_timeout: 5_000,
    }),
  )
}

export function assertTestDatabaseURL(url: URL): void {
  let databaseName = ''
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1))
  } catch {
    // The canonical error below intentionally does not reflect URL data.
  }
  if (!databaseName.endsWith('_test')) {
    throw new Error('Database integration tests require a database name ending in _test.')
  }
}
