import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadDatabaseMigrationConfig } from '@surfgate/config'

import { createDatabase, type Database, type Queryable } from './database.js'

const MIGRATION_FILE_PATTERN = /^\d{4}-[a-z0-9-]+\.sql$/u
const MIGRATION_LOCK_ID = 7_602_451_903
const ONLINE_INDEX_DIRECTIVE = /^-- surfgate:online-index ([a-z][a-z0-9_]*)$/mu
const ONLINE_MIGRATION_TIMEOUT_MS = 30 * 60 * 1_000
const MIGRATION_LOCK_RETRY_MS = 100

type AppliedMigrationRow = Readonly<{ name: string; checksum: string }>

function checksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

async function ensureLedger(transaction: Queryable): Promise<void> {
  await transaction.query(`
    create table if not exists surfgate_migrations (
      name text primary key,
      checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz not null default now()
    )
  `)
}

async function appliedMigration(
  connection: Queryable,
  name: string,
): Promise<AppliedMigrationRow | undefined> {
  return (
    await connection.query<AppliedMigrationRow>(
      'select name, checksum from surfgate_migrations where name = $1',
      [name],
    )
  )[0]
}

function assertChecksum(
  filename: string,
  existing: AppliedMigrationRow | undefined,
  expected: string,
): boolean {
  if (existing === undefined) return false
  if (existing.checksum !== expected) {
    throw new Error(`Applied migration ${basename(filename)} has changed.`)
  }
  return true
}

async function runOnlineIndexMigration(
  connection: Queryable,
  filename: string,
  sql: string,
  expectedChecksum: string,
  indexName: string,
): Promise<void> {
  if (assertChecksum(filename, await appliedMigration(connection, filename), expectedChecksum))
    return
  await connection.query(`select set_config('statement_timeout', $1, false)`, [
    String(ONLINE_MIGRATION_TIMEOUT_MS),
  ])
  await connection.query(`select set_config('lock_timeout', '5000', false)`)
  const indexes = await connection.query<{ exists: boolean }>(
    `select exists(
           select 1 from pg_class index_class
           join pg_index index_definition on index_definition.indexrelid = index_class.oid
           where index_class.relname = $1 and pg_table_is_visible(index_class.oid)
         ) as exists`,
    [indexName],
  )
  // A process can stop after CREATE INDEX CONCURRENTLY but before the ledger write. Recreate
  // any unledgered reserved name so a manual or invalid look-alike can never imply readiness.
  if (indexes[0]?.exists === true) {
    await connection.query(`drop index concurrently if exists "${indexName}"`)
  }
  await connection.query(sql)
  await connection.query('insert into surfgate_migrations (name, checksum) values ($1, $2)', [
    filename,
    expectedChecksum,
  ])
}

async function acquireMigrationLock(connection: Queryable): Promise<void> {
  const deadline = Date.now() + ONLINE_MIGRATION_TIMEOUT_MS
  while (true) {
    const result = await connection.query<{ acquired: boolean }>(
      'select pg_try_advisory_lock($1) as acquired',
      [MIGRATION_LOCK_ID],
    )
    if (result[0]?.acquired === true) return
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new Error('Timed out waiting for the SurfGate migration lock.')
    }
    await delay(Math.min(MIGRATION_LOCK_RETRY_MS, remainingMs))
  }
}

export async function runMigrations(database: Database, directory: string): Promise<void> {
  const sqlFilenames = readdirSync(directory).filter((filename) => filename.endsWith('.sql'))
  const invalidFilename = sqlFilenames.find((filename) => !MIGRATION_FILE_PATTERN.test(filename))
  if (invalidFilename !== undefined) {
    throw new Error(`Migration filename ${basename(invalidFilename)} is invalid.`)
  }
  const filenames = sqlFilenames.toSorted()

  await database.connection(async (lockConnection) => {
    await acquireMigrationLock(lockConnection)
    try {
      await database.transaction(async (transaction) => {
        await ensureLedger(transaction)
      })

      for (const filename of filenames) {
        const sql = readFileSync(join(directory, filename), 'utf8')
        const expectedChecksum = checksum(sql)
        const onlineIndexName = ONLINE_INDEX_DIRECTIVE.exec(sql)?.[1]
        if (onlineIndexName !== undefined) {
          await runOnlineIndexMigration(
            lockConnection,
            filename,
            sql,
            expectedChecksum,
            onlineIndexName,
          )
          continue
        }
        await database.transaction(async (transaction) => {
          if (
            assertChecksum(
              filename,
              await appliedMigration(transaction, filename),
              expectedChecksum,
            )
          )
            return
          await transaction.query(sql)
          await transaction.query(
            'insert into surfgate_migrations (name, checksum) values ($1, $2)',
            [filename, expectedChecksum],
          )
        })
      }
    } finally {
      await lockConnection.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID])
    }
  })
}

export async function runConfiguredMigrations(): Promise<void> {
  const config = loadDatabaseMigrationConfig()
  const database = createDatabase(config.database, {
    queryTimeoutMs: ONLINE_MIGRATION_TIMEOUT_MS,
    statementTimeoutMs: ONLINE_MIGRATION_TIMEOUT_MS,
  })
  try {
    await runMigrations(database, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  } finally {
    await database.close()
  }
}

export function validateConfiguredMigration(): void {
  loadDatabaseMigrationConfig()
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const operation = process.argv.includes('--validate-config')
    ? Promise.resolve(validateConfiguredMigration())
    : runConfiguredMigrations()
  operation.catch(() => {
    console.error('Database migration failed.')
    process.exitCode = 1
  })
}
