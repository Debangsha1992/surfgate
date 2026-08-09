import { expect, it } from 'vitest'

import { assertTestDatabaseURL } from '../../src/database/database.js'
import { database, describeWithDatabase } from './fixture.js'

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
          'audit_events',
          'routing_decisions',
          'session_allocation_attempts',
          'session_create_idempotency',
          'sessions',
          'surfgate_migrations',
          'tenants',
        ],
      ],
    )

    expect(rows.map((row) => row.table_name)).toEqual([
      'api_keys',
      'audit_events',
      'routing_decisions',
      'session_allocation_attempts',
      'session_create_idempotency',
      'sessions',
      'surfgate_migrations',
      'tenants',
    ])
  })

  it('rejects non-test database names before destructive test work', () => {
    expect(() =>
      assertTestDatabaseURL(new URL('postgresql://user:secret@127.0.0.1:5432/surfgate')),
    ).toThrowError('Database integration tests require a database name ending in _test.')
  })
})
