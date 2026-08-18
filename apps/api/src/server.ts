import type { SurfGateConfig } from '@surfgate/config'
import {
  NOOP_CONTROL_PLANE_TELEMETRY,
  type ControlPlaneTelemetry,
  type ManagedTaskTelemetry,
} from '@surfgate/observability'

import {
  buildAPIApplication,
  FASTIFY_LOG_REDACTION_PATHS,
  type APIApplicationDependencies,
} from './app.js'
import { createDatabase, type Database } from './database/database.js'
import { createRedisRateLimitStore, type ControlPlaneRedisStore } from './redis/redis-client.js'
import { createRequestRateLimiter } from './quota/rate-limiter.js'
import { PostgresAPIKeyRepository } from './database/postgres-api-key-repository.js'
import { PostgresTenantRepository } from './database/postgres-tenant-repository.js'
import { createAPIKeyAuthenticator } from './auth/authentication.js'
import { PostgresSessionRepository } from './database/postgres-session-repository.js'
import { PostgresRoutingDecisionRepository } from './database/postgres-routing-decision-repository.js'
import { PostgresAllocationAttemptRepository } from './database/postgres-allocation-attempt-repository.js'
import { PostgresAuditEventRepository } from './database/postgres-audit-event-repository.js'
import { PostgresSessionCreateCoordinator } from './database/postgres-session-create-coordinator.js'
import { createProviderSessionReferenceProtector } from './security/provider-session-reference.js'
import { createTargetPolicy } from '@surfgate/security'
import { createRelayTokenService } from '@surfgate/security'
import { createKitesurfBrowserProvider } from '@surfgate/provider-kitesurf'
import { createChromiumBrowserProvider } from '@surfgate/provider-chromium'
import type { BrowserProvider } from '@surfgate/provider-core'
import { ProviderRegistry } from './providers/provider-registry.js'
import { SessionService } from './services/session-service.js'
import { TaskService } from './services/task-service.js'
import { PostgresManagedTaskRepository } from '@surfgate/task-postgres'
import { createS3ArtifactStorage } from '@surfgate/object-storage'

export interface APIServer {
  start(): Promise<void>
  close(): Promise<void>
}

type ListenOptions = Readonly<{ host: string; port: number }>
const SHUTDOWN_TIMEOUT_MS = 5_000

async function settleWithin(operation: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      operation.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createAPIServer(
  config: SurfGateConfig,
  options: Readonly<{
    database?: Database
    telemetry?: ControlPlaneTelemetry
    taskTelemetry?: ManagedTaskTelemetry
    logger?: APIApplicationDependencies['logger']
    listen?: (options: ListenOptions) => Promise<void>
    redis?: ControlPlaneRedisStore
    providers?: readonly BrowserProvider[]
  }> = {},
): APIServer {
  const database = options.database ?? createDatabase(config.database)
  const telemetry = options.telemetry ?? NOOP_CONTROL_PLANE_TELEMETRY
  const redis = options.redis ?? createRedisRateLimitStore(config.redis)
  const encryption = config.security.providerSessionEncryption
  if (encryption === undefined) {
    throw new Error(
      'Provider session encryption must be configured before the API can allocate sessions.',
    )
  }
  const relaySigning = config.security.relayTokenSigning
  if (relaySigning === undefined) {
    throw new Error('Relay token signing must be configured before the API can issue relay tokens.')
  }
  const providers = options.providers ?? [
    createKitesurfBrowserProvider(config.cloudflare),
    createChromiumBrowserProvider(config.cloudflare),
  ]
  const authenticate = createAPIKeyAuthenticator({
    apiKeys: new PostgresAPIKeyRepository(database),
    tenants: new PostgresTenantRepository(database),
  })
  const sessionService = new SessionService({
    sessions: new PostgresSessionRepository(database),
    decisions: new PostgresRoutingDecisionRepository(database),
    attempts: new PostgresAllocationAttemptRepository(database),
    audit: new PostgresAuditEventRepository(database),
    coordinator: new PostgresSessionCreateCoordinator(database),
    rateLimiter: createRequestRateLimiter(redis),
    targetPolicy: createTargetPolicy(),
    registry: new ProviderRegistry(providers),
    protector: createProviderSessionReferenceProtector(encryption),
    config: config.controlPlane,
    telemetry,
    relay: {
      tokens: createRelayTokenService(relaySigning),
      authorization: redis,
      publicURL: config.relay.publicURL,
      tokenTTLSeconds: config.relay.tokenTTLSeconds,
    },
  })
  const taskRepository = new PostgresManagedTaskRepository(database)
  const taskService = new TaskService({
    sessions: new PostgresSessionRepository(database),
    tasks: taskRepository,
    audit: new PostgresAuditEventRepository(database),
    capabilitiesForRuntime(runtimeClass) {
      return providers
        .find((provider) => provider.descriptor().runtimeClass === runtimeClass)
        ?.descriptor().capabilities
    },
    config: config.tasks,
    ...(options.taskTelemetry === undefined ? {} : { telemetry: options.taskTelemetry }),
    storage: createS3ArtifactStorage(config.objectStorage),
  })
  const app = buildAPIApplication({
    databaseHealth: database,
    redisHealth: redis,
    authenticate,
    sessionService,
    taskService,
    telemetry,
    logger:
      options.logger ??
      ({
        level: config.runtime.logLevel,
        redact: { paths: [...FASTIFY_LOG_REDACTION_PATHS], censor: '[REDACTED]' },
      } as const),
  })
  const listen =
    options.listen ??
    (async (listenOptions: ListenOptions): Promise<void> => {
      await app.listen(listenOptions)
    })
  let startPromise: Promise<void> | undefined
  let closePromise: Promise<void> | undefined

  return Object.freeze({
    start(): Promise<void> {
      if (closePromise !== undefined) {
        return Promise.reject(new Error('The API server has been closed.'))
      }
      startPromise ??= (async () => {
        await listen({ host: config.api.host, port: config.api.port })
        app.log.info({ event: 'api.startup' }, 'SurfGate API started')
      })()
      return startPromise
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        app.log.info({ event: 'api.shutdown' }, 'SurfGate API stopping')
        try {
          if (startPromise !== undefined) {
            await startPromise.catch(() => undefined)
          }
          await app.close()
        } finally {
          await Promise.all([settleWithin(database.close()), settleWithin(redis.close())])
        }
      })()
      return closePromise
    },
  })
}
