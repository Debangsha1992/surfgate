import { loadConfig } from '@surfgate/config'
import { createS3ArtifactStorage } from '@surfgate/object-storage'
import { CHROMIUM_CAPABILITIES } from '@surfgate/provider-chromium'
import { resolveCloudflareBrowserRunConnection } from '@surfgate/provider-cloudflare'
import { KITESURF_CAPABILITIES } from '@surfgate/provider-kitesurf'
import { createProviderSessionReferenceProtector, redactSensitiveData } from '@surfgate/security'
import { createTaskDatabase, PostgresManagedTaskRepository } from '@surfgate/task-postgres'

import { CDPManagedBrowserExecutor } from './cdp-executor.js'
import { createManagedTaskConnectionResolver } from './connection-resolver.js'
import { ManagedTaskWorker, type WorkerLogger } from './managed-task-worker.js'

const logger: WorkerLogger = Object.freeze({
  info(fields, message) {
    process.stdout.write(
      `${JSON.stringify({ level: 'info', message, ...redactSensitiveData(fields) })}\n`,
    )
  },
  warn(fields, message) {
    process.stdout.write(
      `${JSON.stringify({ level: 'warn', message, ...redactSensitiveData(fields) })}\n`,
    )
  },
  error(fields, message) {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', message, ...redactSensitiveData(fields) })}\n`,
    )
  },
})

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
  const database = createTaskDatabase(config.database)
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const worker = new ManagedTaskWorker({
    repository: new PostgresManagedTaskRepository(database),
    executor: new CDPManagedBrowserExecutor(),
    storage: createS3ArtifactStorage(config.objectStorage),
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
  })
  try {
    while (!controller.signal.aborted) {
      const worked = await worker.runOnce(controller.signal)
      if (!worked) await delay(config.tasks.pollIntervalMs, controller.signal)
    }
  } finally {
    await database.close()
  }
}

void main().catch(() => {
  logger.error({ event: 'worker.startup.failed' }, 'SurfGate worker failed')
  process.exitCode = 1
})
