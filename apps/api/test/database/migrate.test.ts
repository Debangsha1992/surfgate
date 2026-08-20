import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { QueryResultRow } from 'pg'
import { afterEach, expect, it, vi } from 'vitest'

import type { Database, Queryable } from '../../src/database/database.js'
import { runMigrations } from '../../src/database/migrate.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function recordingDatabase(events: string[], lockResults: boolean[] = [true]): Database {
  const queryable: Queryable = {
    query<Row extends QueryResultRow = QueryResultRow>(text: string): Promise<readonly Row[]> {
      events.push(text.trim())
      if (text.includes('pg_try_advisory_lock')) {
        return Promise.resolve([
          { acquired: lockResults.shift() ?? lockResults.at(-1) ?? false },
        ] as unknown as readonly Row[])
      }
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
    .map((event, index) => (event.startsWith('select pg_try_advisory_lock(') ? index : -1))
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

it('retries a busy migration lock before opening a transaction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'surfgate-migration-lock-retry-'))
  temporaryDirectories.push(directory)
  const events: string[] = []

  await runMigrations(recordingDatabase(events, [false, true]), directory)

  expect(events.filter((event) => event.startsWith('select pg_try_advisory_lock('))).toHaveLength(2)
  expect(events.indexOf('transaction')).toBeGreaterThan(
    events.findLastIndex((event) => event.startsWith('select pg_try_advisory_lock(')),
  )
})

it('fails after the bounded migration-lock deadline', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'surfgate-migration-lock-timeout-'))
  temporaryDirectories.push(directory)
  const events: string[] = []
  vi.spyOn(Date, 'now')
    .mockReturnValueOnce(0)
    .mockReturnValue(30 * 60 * 1_000 + 1)

  await expect(runMigrations(recordingDatabase(events, [false]), directory)).rejects.toThrow(
    'Timed out waiting for the SurfGate migration lock.',
  )
  expect(events).not.toContain('transaction')
})
