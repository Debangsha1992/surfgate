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
  connection<Result>(operation: (connection: Queryable) => Promise<Result>): Promise<Result>
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
  constructor(
    private readonly pool: Pool,
    private readonly requiredMigration: string,
  ) {
    super(pool)
  }

  async health(): Promise<'ready' | 'unavailable'> {
    try {
      const rows = await this.query<{ compatible: boolean }>(
        `select exists(
           select 1 from surfgate_migrations where name = $1
         ) as compatible`,
        [this.requiredMigration],
      )
      return rows[0]?.compatible === true ? 'ready' : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  async connection<Result>(operation: (connection: Queryable) => Promise<Result>): Promise<Result> {
    const client = await this.pool.connect()
    try {
      return await operation(new PostgresQueryable(client))
    } finally {
      client.release()
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

export function createDatabase(
  config: Pick<DatabaseConfig, 'requiredMigration' | 'url'>,
  options: Readonly<{
    queryTimeoutMs?: number
    statementTimeoutMs?: number
  }> = {},
): Database {
  return new PostgresDatabase(
    new Pool({
      connectionString: config.url.href,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 10,
      maxLifetimeSeconds: 60 * 30,
      query_timeout: options.queryTimeoutMs ?? 6_000,
      statement_timeout: options.statementTimeoutMs ?? 5_000,
    }),
    config.requiredMigration,
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
