import { loadConfig } from '@surfgate/config'
import { createS3ArtifactStorage } from '@surfgate/object-storage'
import { createStructuredLogger, createTelemetryRuntime } from '@surfgate/observability'
import { CHROMIUM_CAPABILITIES } from '@surfgate/provider-chromium'
import { resolveCloudflareBrowserRunConnection } from '@surfgate/provider-cloudflare'
import { KITESURF_CAPABILITIES } from '@surfgate/provider-kitesurf'
import { createProviderSessionReferenceProtector } from '@surfgate/security'
import { createTaskDatabase, PostgresManagedTaskRepository } from '@surfgate/task-postgres'

import { CDPManagedBrowserExecutor } from './cdp-executor.js'
import { createManagedTaskConnectionResolver } from './connection-resolver.js'
import { createWorkerHealthServer } from './health-server.js'
import { awaitWorkerOperation, completeWorkerShutdown } from './lifecycle.js'
import { ManagedTaskWorker, type WorkerLogger } from './managed-task-worker.js'

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

async function main(): Promise<void> {
  const config = loadConfig()
  const encryption = config.security.providerSessionEncryption
  if (encryption === undefined) throw new Error('Worker security configuration is incomplete.')
  const observability = createTelemetryRuntime(config.telemetry, 'worker')
  const logger: WorkerLogger = createStructuredLogger({
    service: observability.serviceName,
    environment: config.runtime.environment,
  })
  const database = createTaskDatabase(config.database)
  const storage = createS3ArtifactStorage(config.objectStorage)
  const health = createWorkerHealthServer(config.worker, {
    database,
    storage: {
      health: () => storage.health?.() ?? Promise.resolve('unavailable'),
    },
    telemetry: observability.managedTasks,
  })
  const controller = new AbortController()
  const stop = (): void => {
    if (controller.signal.aborted) return
    health.markDraining()
    logger.info({ event: 'worker.shutdown.initiated' }, 'SurfGate worker is draining')
    controller.abort()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const worker = new ManagedTaskWorker({
    repository: new PostgresManagedTaskRepository(database),
    executor: new CDPManagedBrowserExecutor(),
    storage,
    resolver: createManagedTaskConnectionResolver({
      protector: createProviderSessionReferenceProtector(encryption),
      resolveProviderConnection: (session) =>
        resolveCloudflareBrowserRunConnection(config.cloudflare, session),
    }),
    capabilitiesForRuntime: (runtime) =>
      runtime === 'kitesurf'
        ? KITESURF_CAPABILITIES
        : runtime === 'chromium'
          ? CHROMIUM_CAPABILITIES
          : undefined,
    config: config.tasks,
    logger,
    telemetry: observability.managedTasks,
  })
  let activeOperationTimedOut = false
  try {
    await health.start()
    logger.info({ event: 'worker.startup' }, 'SurfGate worker started')
    while (!controller.signal.aborted) {
      const result = await awaitWorkerOperation(
        worker.runOnce(controller.signal),
        controller.signal,
        config.worker.drainTimeoutMs,
      )
      if (result.kind === 'timed_out') {
        activeOperationTimedOut = true
        logger.warn(
          { event: 'worker.shutdown.drain_timeout' },
          'Worker drain deadline reached; active work was abandoned for reconciliation',
        )
        break
      }
      if (result.kind === 'failed') throw new Error('Managed task worker iteration failed.')
      if (!result.value) await delay(config.tasks.pollIntervalMs, controller.signal)
    }
  } finally {
    health.markDraining()
    await completeWorkerShutdown({
      activeOperationTimedOut,
      drainTimeoutMs: config.worker.drainTimeoutMs,
      closeHealth: () => health.close(),
      closeDatabase: () => database.close(),
      shutdownTelemetry: () => observability.shutdown(),
      forceExit: (code) => process.exit(code),
      warn: (event) => {
        logger.warn(
          { event },
          event === 'worker.shutdown.forced'
            ? 'Worker drain deadline reached; forcing process exit after telemetry flush'
            : 'Worker dependency shutdown did not complete within the drain deadline',
        )
      },
    })
    if (!activeOperationTimedOut) {
      logger.info({ event: 'worker.shutdown.complete' }, 'SurfGate worker stopped')
    }
  }
}

void main().catch(() => {
  process.stderr.write(
    '{"service":"surfgate-worker","level":"error","event":"worker.startup.failed","message":"SurfGate worker failed"}\n',
  )
  process.exitCode = 1
})
