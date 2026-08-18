import {
  ManagedTaskCreateRequestSchema,
  ManagedTaskResponseSchema,
  SurfGateErrorResponseSchema,
} from '@surfgate/contracts'
import type { ControlPlaneTelemetry } from '@surfgate/observability'
import type { FastifyInstance } from 'fastify'
import type { z } from 'zod'

import type { AuthenticateAPIKey } from './authentication-hook.js'
import { createAuthenticationHook } from './authentication-hook.js'
import type { TaskService } from '../services/task-service.js'
import {
  ArtifactParametersSchema,
  CREATE_TASK_ERROR_STATUSES,
  GET_ARTIFACT_ERROR_STATUSES,
  GET_TASK_ERROR_STATUSES,
  TaskIdempotencyHeadersSchema,
  TaskParametersSchema,
  TaskSessionParametersSchema,
} from './task-operation-contracts.js'

const fastifySchema = (schema: z.ZodType) => schema.toJSONSchema({ target: 'draft-7' })
const errorSchema = fastifySchema(SurfGateErrorResponseSchema)
const errors = (statuses: readonly number[]) =>
  Object.fromEntries(statuses.map((status) => [status, errorSchema]))

export function registerTaskRoutes(
  app: FastifyInstance,
  dependencies: Readonly<{
    authenticate: AuthenticateAPIKey
    service: TaskService
    telemetry: ControlPlaneTelemetry
  }>,
): void {
  app.post(
    '/v1/sessions/:sessionId/tasks',
    {
      schema: {
        params: fastifySchema(TaskSessionParametersSchema),
        headers: fastifySchema(TaskIdempotencyHeadersSchema),
        body: fastifySchema(ManagedTaskCreateRequestSchema),
        response: {
          202: fastifySchema(ManagedTaskResponseSchema),
          ...errors(CREATE_TASK_ERROR_STATUSES),
        },
      },
      preHandler: createAuthenticationHook({
        authenticate: dependencies.authenticate,
        telemetry: dependencies.telemetry,
        requiredScopes: ['tasks:write'],
      }),
    },
    async (request, reply) => {
      const parameters = TaskSessionParametersSchema.parse(request.params)
      const headers = TaskIdempotencyHeadersSchema.parse(request.headers)
      const response = await dependencies.service.create(
        request.auth,
        parameters.sessionId,
        request.body,
        headers['idempotency-key'],
      )
      return reply.status(202).send(response)
    },
  )

  app.get(
    '/v1/tasks/:taskId',
    {
      schema: {
        params: fastifySchema(TaskParametersSchema),
        response: {
          200: fastifySchema(ManagedTaskResponseSchema),
          ...errors(GET_TASK_ERROR_STATUSES),
        },
      },
      preHandler: createAuthenticationHook({
        authenticate: dependencies.authenticate,
        telemetry: dependencies.telemetry,
        requiredScopes: ['tasks:read'],
      }),
    },
    async (request) =>
      dependencies.service.get(request.auth, TaskParametersSchema.parse(request.params).taskId),
  )

  app.get(
    '/v1/artifacts/:artifactId',
    {
      schema: {
        params: fastifySchema(ArtifactParametersSchema),
        response: { ...errors(GET_ARTIFACT_ERROR_STATUSES) },
      },
      preHandler: createAuthenticationHook({
        authenticate: dependencies.authenticate,
        telemetry: dependencies.telemetry,
        requiredScopes: ['artifacts:read'],
      }),
    },
    async (request, reply) => {
      const result = await dependencies.service.getArtifact(
        request.auth,
        ArtifactParametersSchema.parse(request.params).artifactId,
      )
      reply.header('content-type', result.metadata.mediaType)
      reply.header('content-length', String(result.bytes.byteLength))
      reply.header('content-disposition', `attachment; filename="${result.metadata.id}"`)
      return reply.send(Buffer.from(result.bytes))
    },
  )
}
