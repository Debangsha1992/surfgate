import { describe, expect, it, vi } from 'vitest'

import { parseConfig } from '@surfgate/config'
import type { QueryResultRow } from 'pg'

import type { Database, Queryable } from '../src/database/database.js'
import { createAPIServer } from '../src/server.js'

class FakeDatabase implements Database {
  readonly closeSpy = vi.fn(() => Promise.resolve())

  query<Row extends QueryResultRow = QueryResultRow>(): Promise<readonly Row[]> {
    return Promise.resolve([])
  }

  health(): Promise<'ready'> {
    return Promise.resolve('ready')
  }

  transaction<Result>(operation: (transaction: Queryable) => Promise<Result>): Promise<Result> {
    return operation(this)
  }

  close(): Promise<void> {
    return this.closeSpy()
  }
}

describe('API server lifecycle', () => {
  it('starts and closes idempotently without requiring a listening socket', async () => {
    const baseConfig = parseConfig({
      NODE_ENV: 'test',
      SURFGATE_RELAY_PUBLIC_URL: 'ws://127.0.0.1:8081',
      DATABASE_URL: 'postgresql://surfgate:surfgate@127.0.0.1:5432/surfgate',
      REDIS_URL: 'redis://127.0.0.1:6379',
      S3_REGION: 'auto',
      S3_BUCKET: 'surfgate-test',
      SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      SURFGATE_RELAY_TOKEN_SIGNING_KEY: Buffer.alloc(32, 2).toString('base64'),
    })
    const database = new FakeDatabase()
    const listen = vi.fn(() => Promise.resolve())
    const server = createAPIServer(
      { ...baseConfig, api: { ...baseConfig.api, port: 0 } },
      { database, logger: false, listen },
    )

    await Promise.all([server.start(), server.start()])
    await server.start()
    await Promise.all([server.close(), server.close()])

    expect(listen).toHaveBeenCalledTimes(1)
    expect(database.closeSpy).toHaveBeenCalledTimes(1)
    await expect(server.start()).rejects.toThrow('The API server has been closed.')
  })

  it('bounds shutdown when a dependency close never settles', async () => {
    vi.useFakeTimers()
    try {
      const config = parseConfig({
        NODE_ENV: 'test',
        SURFGATE_RELAY_PUBLIC_URL: 'ws://127.0.0.1:8081',
        DATABASE_URL: 'postgresql://surfgate:surfgate@127.0.0.1:5432/surfgate',
        REDIS_URL: 'redis://127.0.0.1:6379',
        S3_REGION: 'auto',
        S3_BUCKET: 'surfgate-test',
        SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
        SURFGATE_RELAY_TOKEN_SIGNING_KEY: Buffer.alloc(32, 2).toString('base64'),
      })
      const server = createAPIServer(config, {
        database: new FakeDatabase(),
        logger: false,
        listen: () => Promise.resolve(),
        redis: {
          increment: () => Promise.resolve(1),
          isSessionRevoked: () => Promise.resolve(false),
          revokeSession: () => Promise.resolve(),
          health: () => Promise.resolve('ready'),
          close: () => new Promise<void>(() => undefined),
        },
      })

      const closing = server.close()
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(closing).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
