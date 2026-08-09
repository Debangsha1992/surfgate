import { loadConfig } from '@surfgate/config'
import { resolveCloudflareBrowserRunConnection } from '@surfgate/provider-cloudflare'
import {
  createProviderSessionReferenceProtector,
  createRelayTokenService,
} from '@surfgate/security'

import { createRelayDatabase } from './postgres-session-repository.js'
import { createRelayCoordinator } from './redis-coordinator.js'
import { createRelayServer, type RelayLogger } from './relay-server.js'
import { createUpstreamConnectionResolver } from './upstream-resolver.js'

const logger: RelayLogger = Object.freeze({
  info(fields, message): void {
    process.stdout.write(`${JSON.stringify({ level: 'info', message, ...fields })}\n`)
  },
  warn(fields, message): void {
    process.stdout.write(`${JSON.stringify({ level: 'warn', message, ...fields })}\n`)
  },
  error(fields, message): void {
    process.stderr.write(`${JSON.stringify({ level: 'error', message, ...fields })}\n`)
  },
})

async function main(): Promise<void> {
  const config = loadConfig()
  const encryption = config.security.providerSessionEncryption
  const signing = config.security.relayTokenSigning
  if (encryption === undefined || signing === undefined) {
    throw new Error('Relay security configuration is incomplete.')
  }
  const database = createRelayDatabase(config.database)
  const coordinator = createRelayCoordinator(config.redis)
  const server = createRelayServer(config.relay, {
    tokens: createRelayTokenService(signing),
    sessions: database,
    coordinator,
    upstream: createUpstreamConnectionResolver({
      protector: createProviderSessionReferenceProtector(encryption),
      resolveProviderConnection: (session) =>
        resolveCloudflareBrowserRunConnection(config.cloudflare, session),
    }),
    logger,
  })
  let stopping: Promise<void> | undefined
  const stop = (): void => {
    stopping ??= server
      .close()
      .finally(() => database.close())
      .catch(() => undefined)
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    await server.start()
  } catch {
    await server.close().catch(() => undefined)
    await database.close().catch(() => undefined)
    throw new Error('SurfGate relay startup failed.')
  }
}

void main().catch(() => {
  logger.error({ event: 'relay.startup.failed' }, 'SurfGate relay failed to start')
  process.exitCode = 1
})
