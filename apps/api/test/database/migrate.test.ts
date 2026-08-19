import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { QueryResultRow } from 'pg'
import { afterEach, expect, it } from 'vitest'

import type { Database, Queryable } from '../../src/database/database.js'
import { runMigrations } from '../../src/database/migrate.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function recordingDatabase(events: string[]): Database {
  const queryable: Queryable = {
    query<Row extends QueryResultRow = QueryResultRow>(text: string): Promise<readonly Row[]> {
      events.push(text.trim())
      return Promise.resolve([])
    },
  }

  return {
    ...queryable,
    health(): Promise<'ready'> {
      return Promise.resolve('ready')
    },
    async connection<Result>(operation: (connection: Queryable) => Promise<Result>) {
      events.push('connection')
      return operation(queryable)
    },
    async transaction<Result>(operation: (transaction: Queryable) => Promise<Result>) {
      events.push('transaction')
      return operation(queryable)
    },
    async close(): Promise<void> {},
  }
}

it('acquires one session migration lock before opening any transaction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'surfgate-migration-lock-'))
  temporaryDirectories.push(directory)
  writeFileSync(
    join(directory, '0010-test-index.sql'),
    '-- surfgate:online-index test_index\ncreate index concurrently test_index on test_table (id);\n',
  )
  const events: string[] = []

  await runMigrations(recordingDatabase(events), directory)

  const lockIndexes = events
    .map((event, index) => (event.startsWith('select pg_advisory_lock(') ? index : -1))
    .filter((index) => index >= 0)
  const unlockIndexes = events
    .map((event, index) => (event.startsWith('select pg_advisory_unlock(') ? index : -1))
    .filter((index) => index >= 0)
  const firstTransaction = events.indexOf('transaction')

  expect(lockIndexes).toHaveLength(1)
  expect(unlockIndexes).toHaveLength(1)
  expect(lockIndexes[0]).toBeLessThan(firstTransaction)
  expect(unlockIndexes[0]).toBeGreaterThan(firstTransaction)
})
