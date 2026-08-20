import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import { assertTestDatabaseURL, createDatabase } from '../../src/database/database.js'
import { runMigrations } from '../../src/database/migrate.js'
import { configuredTestURL, database, describeWithDatabase } from './fixture.js'

describeWithDatabase('control-plane migrations', () => {
  it('creates every durable session control-plane table idempotently', async () => {
    const rows = await database.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = 'public'
         and table_name = any($1::text[])
       order by table_name`,
      [
        [
          'api_keys',
          'artifacts',
          'audit_events',
          'managed_tasks',
          'routing_decisions',
          'session_allocation_attempts',
          'session_create_idempotency',
          'sessions',
          'surfgate_migrations',
          'task_create_idempotency',
          'tenants',
        ],
      ],
    )

    expect(rows.map((row) => row.table_name)).toEqual([
      'api_keys',
      'artifacts',
      'audit_events',
      'managed_tasks',
      'routing_decisions',
      'session_allocation_attempts',
      'session_create_idempotency',
      'sessions',
      'surfgate_migrations',
      'task_create_idempotency',
      'tenants',
    ])

    const indexes = await database.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = current_schema()
         and indexname = any($1::text[])
       order by indexname`,
      [
        [
          'session_create_idempotency_reconciliation_idx',
          'sessions_reconciliation_active_expiry_idx',
          'sessions_reconciliation_failed_idx',
          'sessions_reconciliation_inflight_idx',
          'sessions_reconciliation_terminating_idx',
        ],
      ],
    )
    expect(indexes.map((row) => row.indexname)).toEqual([
      'session_create_idempotency_reconciliation_idx',
      'sessions_reconciliation_active_expiry_idx',
      'sessions_reconciliation_failed_idx',
      'sessions_reconciliation_inflight_idx',
      'sessions_reconciliation_terminating_idx',
    ])
  })

  it('rejects non-test database names before destructive test work', () => {
    expect(() =>
      assertTestDatabaseURL(new URL('postgresql://user:secret@127.0.0.1:5432/surfgate')),
    ).toThrowError('Database integration tests require a database name ending in _test.')
  })

  it('reports an older schema unavailable until the current migration is applied', async () => {
    if (configuredTestURL === undefined) throw new Error('Test database URL is unavailable.')
    const schema = `surfgate_migration_${process.pid}_${Date.now()}`
    const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url))
    const previous = mkdtempSync(join(tmpdir(), 'surfgate-previous-schema-'))
    await database.query(`create schema ${schema}`)
    const scopedURL = new URL(configuredTestURL)
    scopedURL.searchParams.set('options', `-csearch_path=${schema}`)
    const scoped = createDatabase({
      url: scopedURL,
      requiredMigration: '0014-session-reconciliation-claim-index.sql',
    })
    try {
      for (const filename of readdirSync(migrations).filter((name) => name.startsWith('000'))) {
        if (filename.startsWith('0014-')) continue
        cpSync(join(migrations, filename), join(previous, basename(filename)))
      }
      await runMigrations(scoped, previous)
      await expect(scoped.health()).resolves.toBe('unavailable')
      await runMigrations(scoped, migrations)
      await expect(scoped.health()).resolves.toBe('ready')
    } finally {
      await scoped.close()
      await database.query(`drop schema ${schema} cascade`)
      rmSync(previous, { recursive: true, force: true })
    }
  })

  it('supports a migration connection beyond the serving query deadline', async () => {
    if (configuredTestURL === undefined) throw new Error('Test database URL is unavailable.')
    const migrationDatabase = createDatabase(
      {
        url: configuredTestURL,
        requiredMigration: '0014-session-reconciliation-claim-index.sql',
      },
      { queryTimeoutMs: 8_000, statementTimeoutMs: 8_000 },
    )
    try {
      await expect(migrationDatabase.query('select pg_sleep(6.1)')).resolves.toHaveLength(1)
    } finally {
      await migrationDatabase.close()
    }
  }, 10_000)

  it('serializes concurrent migration runners without deadlocking online indexes', async () => {
    if (configuredTestURL === undefined) throw new Error('Test database URL is unavailable.')
    const schema = `surfgate_concurrent_migration_${process.pid}_${Date.now()}`
    const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url))
    await database.query(`create schema ${schema}`)
    const scopedURL = new URL(configuredTestURL)
    scopedURL.searchParams.set('options', `-csearch_path=${schema}`)
    const runners = Array.from({ length: 4 }, () =>
      createDatabase({
        url: scopedURL,
        requiredMigration: '0014-session-reconciliation-claim-index.sql',
      }),
    )
    try {
      await expect(
        Promise.all(runners.map((runner) => runMigrations(runner, migrations))),
      ).resolves.toHaveLength(runners.length)
    } finally {
      await Promise.allSettled(runners.map((runner) => runner.close()))
      await database.query(`drop schema ${schema} cascade`)
    }
  }, 30_000)
})
