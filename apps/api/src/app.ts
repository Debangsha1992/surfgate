import {
  RequestIDSchema,
  SurfGateErrorCodeSchema,
  createSurfGateErrorResponse,
  type SurfGateErrorCode,
} from '@surfgate/contracts'
import { NOOP_CONTROL_PLANE_TELEMETRY, type ControlPlaneTelemetry } from '@surfgate/observability'
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify'

import { AuthenticationError } from './auth/authentication.js'
import { ControlPlaneHTTPError } from './errors/http-error.js'
import { registerHealthRoutes, type DatabaseHealth } from './http/health-routes.js'
import { resolveRequestID } from './http/request-id.js'
import { SessionTransitionError } from './domain/session.js'
import type { AuthenticateAPIKey } from './http/authentication-hook.js'
import { registerSessionRoutes } from './http/session-routes.js'
import type { SessionService } from './services/session-service.js'
import { RateLimitDependencyError, RateLimitExceededError } from './quota/rate-limiter.js'
import { TargetPolicyError } from '@surfgate/security'
import { SENSITIVE_LOG_PATHS } from '@surfgate/security'
import {
  SessionNotFoundError,
  SessionTransitionConflictError,
} from './repositories/session-repository.js'

export const FASTIFY_LOG_REDACTION_PATHS = SENSITIVE_LOG_PATHS

type LoggerOption = FastifyServerOptions['logger']

const FASTIFY_REQUEST_ERROR_STATUS = new Map<string, number>([
  ['FST_ERR_CTP_BODY_TOO_LARGE', 413],
  ['FST_ERR_CTP_INVALID_MEDIA_TYPE', 415],
  ['FST_ERR_CTP_INVALID_CONTENT_LENGTH', 400],
  ['FST_ERR_CTP_EMPTY_JSON_BODY', 400],
  ['FST_ERR_CTP_INVALID_JSON_BODY', 400],
])

export type APIApplicationDependencies = Readonly<{
  databaseHealth: DatabaseHealth
  telemetry?: ControlPlaneTelemetry
  logger?: LoggerOption
  readinessTimeoutMs?: number
  redisHealth?: DatabaseHealth
  authenticate?: AuthenticateAPIKey
  sessionService?: SessionService
}>

function classifyError(error: unknown): Readonly<{ code: SurfGateErrorCode; statusCode: number }> {
  if (error instanceof AuthenticationError) {
    return {
      code: error.code,
      statusCode: error.code === 'AUTH_FORBIDDEN' ? 403 : 401,
    }
  }
  if (error instanceof ControlPlaneHTTPError) {
    return { code: error.code, statusCode: error.statusCode }
  }
  if (error instanceof TargetPolicyError) return { code: error.code, statusCode: 403 }
  if (error instanceof RateLimitExceededError) return { code: error.code, statusCode: 429 }
  if (error instanceof RateLimitDependencyError) return { code: error.code, statusCode: 503 }
  if (error instanceof SessionNotFoundError) {
    return { code: error.code, statusCode: 404 }
  }
  if (error instanceof SessionTransitionError || error instanceof SessionTransitionConflictError) {
    return { code: 'SESSION_INVALID_TRANSITION', statusCode: 409 }
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    'validation' in error &&
    Array.isArray(error.validation)
  ) {
    return { code: 'VALIDATION_INVALID_REQUEST', statusCode: 400 }
  }
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const errorCode = error.code
    if (typeof errorCode === 'string') {
      const statusCode = FASTIFY_REQUEST_ERROR_STATUS.get(errorCode)
      if (statusCode !== undefined) {
        return { code: 'VALIDATION_INVALID_REQUEST', statusCode }
      }
    }
  }
  return { code: 'INTERNAL_ERROR', statusCode: 500 }
}

export function buildAPIApplication(dependencies: APIApplicationDependencies): FastifyInstance {
  const telemetry = dependencies.telemetry ?? NOOP_CONTROL_PLANE_TELEMETRY
  const fastifyOptions: FastifyServerOptions = {
    bodyLimit: 1024 * 1024,
    connectionTimeout: 10_000,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (request) => resolveRequestID(request.headers['x-request-id']),
    logger: dependencies.logger ?? false,
    requestTimeout: 30_000,
  }
  const app = Fastify(fastifyOptions)
  app.decorateRequest('auth')
  app.decorateRequest('startedAtMonotonic', 0)

  app.addHook('onRequest', async (request, reply) => {
    request.startedAtMonotonic = performance.now()
    reply.header('x-request-id', request.id)
    reply.header('cache-control', 'no-store')
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
  })
  app.addHook('onResponse', async (request, reply) => {
    const durationMs = Math.max(0, performance.now() - request.startedAtMonotonic)
    const route = request.routeOptions.url ?? 'unmatched'
    const outcome = reply.statusCode < 500 ? 'success' : 'failure'
    telemetry.recordHTTP({
      method: request.method,
      route,
      statusCode: reply.statusCode,
      durationMs,
      outcome,
    })
    request.log.info(
      {
        event: 'api.request.completed',
        requestID: request.id,
        route,
        statusCode: reply.statusCode,
        durationMs,
        outcome,
      },
      'API request completed',
    )
  })

  app.setNotFoundHandler(async (request, reply) => {
    const requestID = RequestIDSchema.parse(request.id)
    return reply
      .status(404)
      .send(
        createSurfGateErrorResponse({ code: 'VALIDATION_INVALID_REQUEST', requestId: requestID }),
      )
  })
  app.setErrorHandler(async (error, request, reply) => {
    const classified = classifyError(error)
    const validatedCode = SurfGateErrorCodeSchema.parse(classified.code)
    if (classified.statusCode >= 500) {
      request.log.error(
        { event: 'api.request.failed', requestID: request.id, code: validatedCode },
        'API request failed',
      )
    }
    return reply.status(classified.statusCode).send(
      createSurfGateErrorResponse({
        code: validatedCode,
        requestId: RequestIDSchema.parse(request.id),
      }),
    )
  })

  registerHealthRoutes(app, {
    databaseHealth: dependencies.databaseHealth,
    telemetry,
    ...(dependencies.redisHealth === undefined ? {} : { redisHealth: dependencies.redisHealth }),
    ...(dependencies.readinessTimeoutMs === undefined
      ? {}
      : { timeoutMs: dependencies.readinessTimeoutMs }),
  })
  if (dependencies.authenticate !== undefined && dependencies.sessionService !== undefined) {
    registerSessionRoutes(app, {
      authenticate: dependencies.authenticate,
      service: dependencies.sessionService,
      telemetry,
    })
  }
  return app
}
