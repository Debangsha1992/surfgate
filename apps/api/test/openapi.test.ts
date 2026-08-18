import { describe, expect, it } from 'vitest'

import { buildOpenAPIDocument } from '../src/http/openapi.js'
import {
  IdempotencyHeadersSchema,
  SessionParametersSchema,
} from '../src/http/session-operation-contracts.js'

type Operation = Readonly<{
  security: readonly unknown[]
  parameters: readonly Readonly<Record<string, unknown>>[]
  responses: Readonly<Record<string, unknown>>
}>
type SessionOpenAPI = Readonly<{
  paths: Readonly<{
    '/v1/sessions': Readonly<{ post: Operation }>
    '/v1/sessions/{sessionId}': Readonly<{ get: Operation; delete: Operation }>
    '/v1/sessions/{sessionId}/relay-token': Readonly<{ post: Operation }>
    '/v1/sessions/{sessionId}/tasks': Readonly<{ post: Operation }>
    '/v1/tasks/{taskId}': Readonly<{ get: Operation }>
    '/v1/artifacts/{artifactId}': Readonly<{ get: Operation }>
  }>
}>

describe('SurfGate v1 OpenAPI', () => {
  it('derives all session operations from runtime schemas without provider fields', () => {
    const document = buildOpenAPIDocument() as SessionOpenAPI
    expect(Object.keys(document.paths)).toEqual([
      '/v1/sessions',
      '/v1/sessions/{sessionId}',
      '/v1/sessions/{sessionId}/relay-token',
      '/v1/sessions/{sessionId}/tasks',
      '/v1/tasks/{taskId}',
      '/v1/artifacts/{artifactId}',
    ])
    expect(document.paths['/v1/sessions'].post.security).toEqual([{ bearerAuth: [] }])
    expect(document.paths['/v1/sessions'].post.parameters).toContainEqual(
      expect.objectContaining({ name: 'Idempotency-Key', required: true }),
    )
    expect(document.paths['/v1/sessions/{sessionId}']).toHaveProperty('get')
    expect(document.paths['/v1/sessions/{sessionId}']).toHaveProperty('delete')
    expect(Object.keys(document.paths['/v1/sessions'].post.responses).map(Number)).toEqual([
      201, 400, 401, 403, 409, 413, 415, 422, 429, 500, 502, 503, 504,
    ])
    expect(
      Object.keys(document.paths['/v1/sessions/{sessionId}'].get.responses).map(Number),
    ).toEqual([200, 400, 401, 403, 404, 500])
    expect(
      Object.keys(document.paths['/v1/sessions/{sessionId}'].delete.responses).map(Number),
    ).toEqual([200, 400, 401, 403, 404, 409, 500, 502, 503, 504])
    expect(
      Object.keys(document.paths['/v1/sessions/{sessionId}/relay-token'].post.responses).map(
        Number,
      ),
    ).toEqual([200, 400, 401, 403, 404, 409, 500, 503])
    const idempotencyParameter = document.paths['/v1/sessions'].post.parameters[0]
    expect(idempotencyParameter?.schema).toEqual(
      IdempotencyHeadersSchema.toJSONSchema().properties?.['idempotency-key'],
    )
    const sessionParameter = document.paths['/v1/sessions/{sessionId}'].get.parameters[0]
    expect(sessionParameter?.schema).toEqual(
      SessionParametersSchema.toJSONSchema().properties?.sessionId,
    )
    const serialized = JSON.stringify(document)
    expect(serialized).toContain('webSocketUrl')
    expect(serialized).toContain('createManagedTask')
    expect(serialized).toContain('downloadArtifact')
    expect(serialized).not.toContain('providerSessionReference')
    expect(serialized).not.toContain('apiToken')
  })
})
