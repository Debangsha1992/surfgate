import { loadConfig } from '@surfgate/config'
import { createStructuredLogger, createTelemetryRuntime } from '@surfgate/observability'
import { resolveCloudflareBrowserRunConnection } from '@surfgate/provider-cloudflare'
import {
  createProviderSessionReferenceProtector,
  createRelayTokenService,
} from '@surfgate/security'

import { createRelayDatabase } from './postgres-session-repository.js'
import { completeRelayShutdown } from './lifecycle.js'
import { createRelayCoordinator } from './redis-coordinator.js'
import { createRelayServer, type RelayLogger } from './relay-server.js'
import { createUpstreamConnectionResolver } from './upstream-resolver.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const encryption = config.security.providerSessionEncryption
  const signing = config.security.relayTokenSigning
  if (encryption === undefined || signing === undefined) {
    throw new Error('Relay security configuration is incomplete.')
  }
  const observability = createTelemetryRuntime(config.telemetry, 'relay')
  const logger: RelayLogger = createStructuredLogger({
    service: observability.serviceName,
    environment: config.runtime.environment,
  })
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
    telemetry: observability.relay,
    logger,
  })
  let stopping: Promise<void> | undefined
  const stop = (): void => {
    stopping ??= completeRelayShutdown({
      drainTimeoutMs: config.relay.drainTimeoutMs,
      closeServer: () => server.close(),
      closeDatabase: () => database.close(),
      shutdownTelemetry: () => observability.shutdown(),
      forceExit: (code) => process.exit(code),
      warn: () => {
        logger.warn(
          { event: 'relay.shutdown.dependency_timeout' },
          'Relay shutdown exceeded a dependency deadline',
        )
      },
    }).catch(() => undefined)
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    await server.start()
  } catch {
    await completeRelayShutdown({
      drainTimeoutMs: config.relay.drainTimeoutMs,
      closeServer: () => server.close(),
      closeDatabase: () => database.close(),
      shutdownTelemetry: () => observability.shutdown(),
      forceExit: (code) => process.exit(code),
      warn: () => {
        logger.warn(
          { event: 'relay.shutdown.dependency_timeout' },
          'Relay shutdown exceeded a dependency deadline',
        )
      },
    })
    throw new Error('SurfGate relay startup failed.')
  }
}

void main().catch(() => {
  process.stderr.write(
    '{"service":"surfgate-relay","level":"error","event":"relay.startup.failed","message":"SurfGate relay failed to start"}\n',
  )
  process.exitCode = 1
})
