import { afterEach, describe, expect, it } from 'vitest'

import { createWorkerHealthServer, type WorkerHealthServer } from '../src/health-server.js'

const servers: WorkerHealthServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('worker health server', () => {
  it('separates liveness from dependency-backed readiness and draining', async () => {
    let database: 'ready' | 'unavailable' = 'ready'
    const server = createWorkerHealthServer(
      { healthHost: '127.0.0.1', healthPort: 0, readinessTimeoutMs: 100 },
      {
        database: { health: () => Promise.resolve(database) },
        storage: { health: () => Promise.resolve('ready') },
      },
    )
    servers.push(server)
    const port = await server.start()

    await expect(
      fetch(`http://127.0.0.1:${port}/health/live`).then((r) => r.json()),
    ).resolves.toEqual({ status: 'alive' })
    await expect(
      fetch(`http://127.0.0.1:${port}/health/ready`).then(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
    ).resolves.toEqual({
      status: 200,
      body: { status: 'ready', dependencies: { objectStorage: 'ready', postgres: 'ready' } },
    })

    database = 'unavailable'
    const unavailable = await fetch(`http://127.0.0.1:${port}/health/ready`)
    expect(unavailable.status).toBe(503)
    server.markDraining()
    const draining = await fetch(`http://127.0.0.1:${port}/health/ready`)
    expect(draining.status).toBe(503)
  })

  it('bounds dependency probes and never returns diagnostics or secrets', async () => {
    const server = createWorkerHealthServer(
      { healthHost: '127.0.0.1', healthPort: 0, readinessTimeoutMs: 5 },
      {
        database: { health: () => new Promise(() => undefined) },
        storage: { health: () => Promise.reject(new Error('Bearer storage-secret')) },
      },
    )
    servers.push(server)
    const port = await server.start()

    const response = await fetch(`http://127.0.0.1:${port}/health/ready`)
    const body = await response.text()
    expect(response.status).toBe(503)
    expect(body).not.toContain('storage-secret')
    expect(body).not.toContain('Bearer')
  })
})
