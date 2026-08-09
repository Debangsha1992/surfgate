import { loadConfig } from '@surfgate/config'

import { createAPIServer } from './server.js'

async function main(): Promise<void> {
  const server = createAPIServer(loadConfig())
  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    server.close().catch(() => {
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  try {
    await server.start()
  } catch (error: unknown) {
    await server.close()
    throw error
  }
}

main().catch(() => {
  console.error('SurfGate API failed to start.')
  process.exitCode = 1
})
