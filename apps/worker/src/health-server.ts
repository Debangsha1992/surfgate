import { createServer, type Server } from 'node:http'

import type { WorkerConfig } from '@surfgate/config'
import type { ManagedTaskTelemetry } from '@surfgate/observability'

type DependencyHealth = Readonly<{ health(): Promise<'ready' | 'unavailable'> }>

export interface WorkerHealthServer {
  start(): Promise<number>
  markDraining(): void
  close(): Promise<void>
}

async function boundedHealth(
  dependency: DependencyHealth,
  timeoutMs: number,
): Promise<'ready' | 'unavailable'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      dependency.health().catch(() => 'unavailable' as const),
      new Promise<'unavailable'>((resolve) => {
        timer = setTimeout(() => resolve('unavailable'), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createWorkerHealthServer(
  config: Pick<WorkerConfig, 'healthHost' | 'healthPort' | 'readinessTimeoutMs'>,
  dependencies: Readonly<{
    database: DependencyHealth
    storage: DependencyHealth
    telemetry?: ManagedTaskTelemetry
  }>,
): WorkerHealthServer {
  let draining = false
  let started = false
  let startPromise: Promise<number> | undefined
  let closePromise: Promise<void> | undefined
  const server: Server = createServer((request, response) => {
    void (async () => {
      response.setHeader('content-type', 'application/json')
      response.setHeader('cache-control', 'no-store')
      if (request.url === '/health/live') {
        response.writeHead(200)
        response.end('{"status":"alive"}')
        return
      }
      if (request.url !== '/health/ready') {
        response.writeHead(404)
        response.end()
        return
      }
      const startedAt = performance.now()
      const [postgres, objectStorage] = await Promise.all([
        boundedHealth(dependencies.database, config.readinessTimeoutMs),
        boundedHealth(dependencies.storage, config.readinessTimeoutMs),
      ])
      const durationMs = Math.max(0, performance.now() - startedAt)
      dependencies.telemetry?.recordDependencyHealth?.({
        dependency: 'postgresql',
        status: postgres,
        durationMs,
      })
      dependencies.telemetry?.recordDependencyHealth?.({
        dependency: 'object_storage',
        status: objectStorage,
        durationMs,
      })
      const ready = !draining && postgres === 'ready' && objectStorage === 'ready'
      response.writeHead(ready ? 200 : 503)
      response.end(
        JSON.stringify({
          status: ready ? 'ready' : 'not_ready',
          dependencies: { postgres, objectStorage },
        }),
      )
    })().catch(() => {
      if (!response.headersSent) response.writeHead(503, { 'content-type': 'application/json' })
      response.end('{"status":"not_ready"}')
    })
  })
  return Object.freeze({
    start(): Promise<number> {
      startPromise ??= new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.healthPort, config.healthHost, () => {
          server.removeListener('error', reject)
          started = true
          const address = server.address()
          if (address === null || typeof address === 'string') {
            reject(new Error('Worker health address is unavailable.'))
            return
          }
          resolve(address.port)
        })
      })
      return startPromise
    },
    markDraining(): void {
      draining = true
    },
    close(): Promise<void> {
      draining = true
      closePromise ??= started
        ? new Promise<void>((resolve) => server.close(() => resolve()))
        : Promise.resolve()
      return closePromise
    },
  })
}
