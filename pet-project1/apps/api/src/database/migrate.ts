import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadConfig } from '@surfgate/config'

import { createDatabase, type Database, type Queryable } from './database.js'

const MIGRATION_FILE_PATTERN = /^\d{4}-[a-z0-9-]+\.sql$/u
const MIGRATION_LOCK_ID = 7_602_451_903

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

export async function runMigrations(database: Database, directory: string): Promise<void> {
  const sqlFilenames = readdirSync(directory).filter((filename) => filename.endsWith('.sql'))
  const invalidFilename = sqlFilenames.find((filename) => !MIGRATION_FILE_PATTERN.test(filename))
  if (invalidFilename !== undefined) {
    throw new Error(`Migration filename ${basename(invalidFilename)} is invalid.`)
  }
  const filenames = sqlFilenames.toSorted()

  await database.transaction(async (transaction) => {
    await transaction.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID])
    await ensureLedger(transaction)
    const applied = await transaction.query<AppliedMigrationRow>(
      'select name, checksum from surfgate_migrations',
    )
    const checksums = new Map(applied.map((migration) => [migration.name, migration.checksum]))

    for (const filename of filenames) {
      const sql = readFileSync(join(directory, filename), 'utf8')
      const expectedChecksum = checksum(sql)
      const existingChecksum = checksums.get(filename)
      if (existingChecksum !== undefined) {
        if (existingChecksum !== expectedChecksum) {
          throw new Error(`Applied migration ${basename(filename)} has changed.`)
        }
        continue
      }
      await transaction.query(sql)
      await transaction.query('insert into surfgate_migrations (name, checksum) values ($1, $2)', [
        filename,
        expectedChecksum,
      ])
    }
  })
}

export async function runConfiguredMigrations(): Promise<void> {
  const config = loadConfig()
  const database = createDatabase(config.database)
  try {
    await runMigrations(database, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  } finally {
    await database.close()
  }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  runConfiguredMigrations().catch(() => {
    console.error('Database migration failed.')
    process.exitCode = 1
  })
}
