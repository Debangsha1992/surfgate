import { loadConfig } from '@surfgate/config'
import { createTelemetryRuntime } from '@surfgate/observability'

import { createAPIServer } from './server.js'

async function main(): Promise<void> {
  const config = loadConfig()
  if (
    config.security.providerSessionEncryption === undefined ||
    config.security.relayTokenSigning === undefined
  ) {
    throw new Error('API security configuration is incomplete.')
  }
  const observability = createTelemetryRuntime(config.telemetry, 'api')
  const server = createAPIServer(config, {
    telemetry: observability.controlPlane,
    taskTelemetry: observability.managedTasks,
  })
  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    server
      .close()
      .then(() => observability.shutdown())
      .catch(() => {
        process.exitCode = 1
      })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  try {
    await server.start()
  } catch (error: unknown) {
    await server.close()
    await observability.shutdown()
    throw error
  }
}

main().catch(() => {
  console.error('SurfGate API failed to start.')
  process.exitCode = 1
})
