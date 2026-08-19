import { loadConfig } from '@surfgate/config'
import { createTelemetryRuntime } from '@surfgate/observability'

import { createAPIServer } from './server.js'
import { completeAPIShutdown } from './lifecycle.js'

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
    void completeAPIShutdown({
      closeServer: () => server.close(),
      shutdownTelemetry: () => observability.shutdown(),
      warn: () => console.error('SurfGate API forced shutdown after its drain deadline.'),
      forceExit: (code) => process.exit(code),
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  try {
    await server.start()
  } catch (error: unknown) {
    await server.close().catch(() => undefined)
    await observability.shutdown()
    throw error
  }
}

main().catch(() => {
  console.error('SurfGate API failed to start.')
  process.exitCode = 1
})
