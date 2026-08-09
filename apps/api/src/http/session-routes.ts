import {
  SessionCreateRequestSchema,
  SessionCreateResponseSchema,
  SessionGetResponseSchema,
  SessionTerminationResponseSchema,
  SurfGateErrorResponseSchema,
} from '@surfgate/contracts'
import type { ControlPlaneTelemetry } from '@surfgate/observability'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'

import type { AuthenticateAPIKey } from './authentication-hook.js'
import { createAuthenticationHook } from './authentication-hook.js'
import type { SessionService } from '../services/session-service.js'
import { buildOpenAPIDocument } from './openapi.js'
import {
  CREATE_SESSION_ERROR_STATUSES,
  DELETE_SESSION_ERROR_STATUSES,
  GET_SESSION_ERROR_STATUSES,
  IdempotencyHeadersSchema,
  SessionParametersSchema,
} from './session-operation-contracts.js'
const fastifySchema = (schema: z.ZodType) => schema.toJSONSchema({ target: 'draft-7' })
const errorSchema = fastifySchema(SurfGateErrorResponseSchema)
const errorResponses = (statuses: readonly number[]) =>
  Object.fromEntries(statuses.map((status) => [status, errorSchema]))

function requestAbortSignal(
  request: FastifyRequest,
  reply: FastifyReply,
): Readonly<{ signal: AbortSignal; release(): void }> {
  const controller = new AbortController()
  const abortRequest = (): void => controller.abort()
  const abortReply = (): void => {
    if (!reply.raw.writableFinished) controller.abort()
  }
  request.raw.once('aborted', abortRequest)
  reply.raw.once('close', abortReply)
  return Object.freeze({
    signal: controller.signal,
    release(): void {
      request.raw.removeListener('aborted', abortRequest)
      reply.raw.removeListener('close', abortReply)
    },
  })
}

export function registerSessionRoutes(
  app: FastifyInstance,
  dependencies: Readonly<{
    authenticate: AuthenticateAPIKey
    service: SessionService
    telemetry: ControlPlaneTelemetry
  }>,
): void {
  app.get('/openapi.json', () => buildOpenAPIDocument())

  app.post(
    '/v1/sessions',
    {
      schema: {
        headers: fastifySchema(IdempotencyHeadersSchema),
        body: fastifySchema(SessionCreateRequestSchema),
        response: {
          201: fastifySchema(SessionCreateResponseSchema),
          ...errorResponses(CREATE_SESSION_ERROR_STATUSES),
        },
      },
      preHandler: createAuthenticationHook({
        authenticate: dependencies.authenticate,
        telemetry: dependencies.telemetry,
        requiredScopes: ['sessions:write'],
      }),
    },
    async (request, reply) => {
      const headers = IdempotencyHeadersSchema.parse(request.headers)
      const cancellation = requestAbortSignal(request, reply)
      try {
        const response = await dependencies.service.create(
          request.auth,
          request.body,
          headers['idempotency-key'],
          cancellation.signal,
        )
        return reply.status(201).send(response)
      } finally {
        cancellation.release()
      }
    },
  )

  app.get(
    '/v1/sessions/:sessionId',
    {
      schema: {
        params: fastifySchema(SessionParametersSchema),
        response: {
          200: fastifySchema(SessionGetResponseSchema),
          ...errorResponses(GET_SESSION_ERROR_STATUSES),
        },
      },
      preHandler: createAuthenticationHook({
        authenticate: dependencies.authenticate,
        telemetry: dependencies.telemetry,
        requiredScopes: ['sessions:read'],
      }),
    },
    async (request) => {
      const parameters = SessionParametersSchema.parse(request.params)
      return dependencies.service.get(request.auth, parameters.sessionId)
    },
  )

  app.delete(
    '/v1/sessions/:sessionId',
    {
      schema: {
        params: fastifySchema(SessionParametersSchema),
        response: {
          200: fastifySchema(SessionTerminationResponseSchema),
          ...errorResponses(DELETE_SESSION_ERROR_STATUSES),
        },
      },
      preHandler: createAuthenticationHook({
        authenticate: dependencies.authenticate,
        telemetry: dependencies.telemetry,
        requiredScopes: ['sessions:terminate'],
      }),
    },
    async (request, reply) => {
      const parameters = SessionParametersSchema.parse(request.params)
      const cancellation = requestAbortSignal(request, reply)
      try {
        return await dependencies.service.terminate(
          request.auth,
          parameters.sessionId,
          cancellation.signal,
        )
      } finally {
        cancellation.release()
      }
    },
  )
}
