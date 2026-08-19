import { LivenessResponseSchema, ReadinessResponseSchema } from '@surfgate/contracts'
import type { ControlPlaneTelemetry } from '@surfgate/observability'
import type { FastifyInstance } from 'fastify'

import { validatePublicResponse } from './validation.js'

export type DatabaseHealth = Readonly<{
  health(): Promise<'ready' | 'unavailable'>
}>

const DEFAULT_READINESS_TIMEOUT_MS = 5_500

async function checkDatabaseHealth(
  databaseHealth: DatabaseHealth,
  timeoutMs: number,
): Promise<'ready' | 'unavailable'> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      databaseHealth.health().catch(() => 'unavailable' as const),
      new Promise<'unavailable'>((resolve) => {
        timeout = setTimeout(() => resolve('unavailable'), timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

export function registerHealthRoutes(
  app: FastifyInstance,
  dependencies: Readonly<{
    databaseHealth: DatabaseHealth
    telemetry: ControlPlaneTelemetry
    redisHealth?: DatabaseHealth
    timeoutMs?: number
  }>,
): void {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  app.get(
    '/health/live',
    { schema: { response: { 200: LivenessResponseSchema.toJSONSchema() } } },
    () => validatePublicResponse(LivenessResponseSchema, { status: 'alive' }),
  )

  app.get(
    '/health/ready',
    {
      schema: {
        response: {
          200: ReadinessResponseSchema.toJSONSchema(),
          503: ReadinessResponseSchema.toJSONSchema(),
        },
      },
    },
    async (_request, reply) => {
      const postgresStartedAt = performance.now()
      const postgres = await checkDatabaseHealth(dependencies.databaseHealth, timeoutMs)
      dependencies.telemetry.recordDependencyHealth?.({
        dependency: 'postgresql',
        status: postgres,
        durationMs: Math.max(0, performance.now() - postgresStartedAt),
      })
      const redisStartedAt = performance.now()
      const redis =
        dependencies.redisHealth === undefined
          ? undefined
          : await checkDatabaseHealth(dependencies.redisHealth, timeoutMs)
      if (redis !== undefined) {
        dependencies.telemetry.recordDependencyHealth?.({
          dependency: 'redis',
          status: redis,
          durationMs: Math.max(0, performance.now() - redisStartedAt),
        })
      }
      dependencies.telemetry.recordDatabaseHealth(postgres)
      const response = validatePublicResponse(ReadinessResponseSchema, {
        status: postgres === 'ready' && redis !== 'unavailable' ? 'ready' : 'not_ready',
        dependencies: { postgres, ...(redis === undefined ? {} : { redis }) },
      })
      return postgres === 'ready' && redis !== 'unavailable'
        ? response
        : reply.status(503).send(response)
    },
  )
}
