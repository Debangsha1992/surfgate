import {
  SessionCreateRequestSchema,
  SessionCreateResponseSchema,
  SessionGetResponseSchema,
  SessionTerminationResponseSchema,
  RelayTokenResponseSchema,
  SurfGateErrorResponseSchema,
  ManagedTaskCreateRequestSchema,
  ManagedTaskResponseSchema,
} from '@surfgate/contracts'
import {
  CREATE_SESSION_ERROR_STATUSES,
  DELETE_SESSION_ERROR_STATUSES,
  GET_SESSION_ERROR_STATUSES,
  RELAY_TOKEN_ERROR_STATUSES,
  IdempotencyHeadersSchema,
  SessionParametersSchema,
} from './session-operation-contracts.js'
import {
  ArtifactParametersSchema,
  CREATE_TASK_ERROR_STATUSES,
  GET_ARTIFACT_ERROR_STATUSES,
  GET_TASK_ERROR_STATUSES,
  TaskIdempotencyHeadersSchema,
  TaskParametersSchema,
} from './task-operation-contracts.js'

export function buildOpenAPIDocument(): Readonly<Record<string, unknown>> {
  const errorResponses = (statuses: readonly number[]) =>
    Object.fromEntries(
      statuses.map((status) => [
        status,
        {
          description: 'Stable SurfGate error',
          content: { 'application/json': { schema: SurfGateErrorResponseSchema.toJSONSchema() } },
        },
      ]),
    )
  const idempotencyHeaderSchema =
    IdempotencyHeadersSchema.toJSONSchema().properties?.['idempotency-key']
  const sessionIDSchema = SessionParametersSchema.toJSONSchema().properties?.sessionId
  const taskIDSchema = TaskParametersSchema.toJSONSchema().properties?.taskId
  const artifactIDSchema = ArtifactParametersSchema.toJSONSchema().properties?.artifactId
  const taskIdempotencySchema =
    TaskIdempotencyHeadersSchema.toJSONSchema().properties?.['idempotency-key']
  return Object.freeze({
    openapi: '3.1.0',
    info: { title: 'SurfGate API', version: '1.0.0' },
    servers: [],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'SurfGate API key' },
      },
    },
    paths: {
      '/v1/sessions': {
        post: {
          operationId: 'createSession',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: idempotencyHeaderSchema,
            },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: SessionCreateRequestSchema.toJSONSchema() } },
          },
          responses: {
            201: {
              description:
                'Session allocated. Active sessions can obtain a separate short-lived relay credential.',
              content: {
                'application/json': { schema: SessionCreateResponseSchema.toJSONSchema() },
              },
            },
            ...errorResponses(CREATE_SESSION_ERROR_STATUSES),
          },
        },
      },
      '/v1/sessions/{sessionId}': {
        get: {
          operationId: 'getSession',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'sessionId', in: 'path', required: true, schema: sessionIDSchema }],
          responses: {
            200: {
              description: 'Tenant-scoped session',
              content: { 'application/json': { schema: SessionGetResponseSchema.toJSONSchema() } },
            },
            ...errorResponses(GET_SESSION_ERROR_STATUSES),
          },
        },
        delete: {
          operationId: 'terminateSession',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'sessionId', in: 'path', required: true, schema: sessionIDSchema }],
          responses: {
            200: {
              description: 'Idempotent terminal session state',
              content: {
                'application/json': { schema: SessionTerminationResponseSchema.toJSONSchema() },
              },
            },
            ...errorResponses(DELETE_SESSION_ERROR_STATUSES),
          },
        },
      },
      '/v1/sessions/{sessionId}/relay-token': {
        post: {
          operationId: 'issueRelayToken',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'sessionId', in: 'path', required: true, schema: sessionIDSchema }],
          responses: {
            200: {
              description: 'Short-lived SurfGate relay credential for an active session',
              content: { 'application/json': { schema: RelayTokenResponseSchema.toJSONSchema() } },
            },
            ...errorResponses(RELAY_TOKEN_ERROR_STATUSES),
          },
        },
      },
      '/v1/sessions/{sessionId}/tasks': {
        post: {
          operationId: 'createManagedTask',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'sessionId', in: 'path', required: true, schema: sessionIDSchema },
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: taskIdempotencySchema,
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: ManagedTaskCreateRequestSchema.toJSONSchema() },
            },
          },
          responses: {
            202: {
              description: 'Managed task durably queued',
              content: { 'application/json': { schema: ManagedTaskResponseSchema.toJSONSchema() } },
            },
            ...errorResponses(CREATE_TASK_ERROR_STATUSES),
          },
        },
      },
      '/v1/tasks/{taskId}': {
        get: {
          operationId: 'getManagedTask',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: taskIDSchema }],
          responses: {
            200: {
              description: 'Tenant-scoped managed task status and safe result metadata',
              content: { 'application/json': { schema: ManagedTaskResponseSchema.toJSONSchema() } },
            },
            ...errorResponses(GET_TASK_ERROR_STATUSES),
          },
        },
      },
      '/v1/artifacts/{artifactId}': {
        get: {
          operationId: 'downloadArtifact',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'artifactId', in: 'path', required: true, schema: artifactIDSchema },
          ],
          responses: {
            200: {
              description: 'Authenticated tenant-scoped artifact download',
              content: {
                'image/png': { schema: { type: 'string', contentEncoding: 'binary' } },
                'image/jpeg': { schema: { type: 'string', contentEncoding: 'binary' } },
                'application/pdf': { schema: { type: 'string', contentEncoding: 'binary' } },
              },
            },
            ...errorResponses(GET_ARTIFACT_ERROR_STATUSES),
          },
        },
      },
    },
  })
}
