import { expect, it } from 'vitest'

import {
  createRestoreDatabaseName,
  runPostgresRestoreDrill,
} from '../../src/database/restore-drill.js'

it('refuses to run a restore drill against a non-test database', async () => {
  await expect(
    runPostgresRestoreDrill(
      new URL('postgresql://surfgate:secret@database.example/surfgate'),
      '0014-session-reconciliation-claim-index.sql',
    ),
  ).rejects.toThrowError('Database integration tests require a database name ending in _test.')
})

it('creates a bounded restore target distinct from a maximum-length source name', () => {
  const source = `${'x'.repeat(58)}_test`
  const target = createRestoreDatabaseName(source)

  expect(Buffer.byteLength(target, 'utf8')).toBeLessThanOrEqual(63)
  expect(target).not.toBe(source)
  expect(target).toMatch(/^surfgate_restore_[0-9a-f]{32}$/u)
})
