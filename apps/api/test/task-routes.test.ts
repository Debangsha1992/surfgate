import {
  APIKeyIDSchema,
  ArtifactIDSchema,
  RequestIDSchema,
  SessionIDSchema,
  TaskIDSchema,
  TenantIDSchema,
} from '@surfgate/contracts'
import { describe, expect, it, vi } from 'vitest'

import { buildAPIApplication } from '../src/app.js'

const sessionID = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const taskID = TaskIDSchema.parse('tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const artifactID = ArtifactIDSchema.parse('art_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const task = {
  id: taskID,
  sessionId: sessionID,
  type: 'extract',
  status: 'queued',
  attemptCount: 0,
  result: null,
  failureCode: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  startedAt: null,
  completedAt: null,
  failedAt: null,
  nextAttemptAt: null,
} as const

describe('managed task routes', () => {
  it('keeps authenticated task creation/status/artifact handlers thin', async () => {
    const taskService = {
      create: vi.fn().mockResolvedValue({ task }),
      get: vi.fn().mockResolvedValue({ task }),
      getArtifact: vi.fn().mockResolvedValue({
        metadata: {
          id: artifactID,
          mediaType: 'image/png',
          byteSize: 3,
          sha256: 'a'.repeat(64),
          createdAt: '2026-08-10T00:00:00.000Z',
          expiresAt: '2026-08-11T00:00:00.000Z',
        },
        bytes: new Uint8Array([1, 2, 3]),
      }),
    }
    const app = buildAPIApplication({
      databaseHealth: { health: () => Promise.resolve('ready') },
      authenticate: (input) =>
        Promise.resolve({
          tenantID: TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
          apiKeyID: APIKeyIDSchema.parse('key_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
          requestID: RequestIDSchema.parse(input.requestID),
          scopes: ['tasks:read', 'tasks:write', 'artifacts:read'],
        }),
      sessionService: {} as never,
      taskService: taskService as never,
    })
    const created = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionID}/tasks`,
      headers: { authorization: 'Bearer safe', 'idempotency-key': 'task-key' },
      payload: { type: 'extract' },
    })
    const fetched = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskID}`,
      headers: { authorization: 'Bearer safe' },
    })
    const artifact = await app.inject({
      method: 'GET',
      url: `/v1/artifacts/${artifactID}`,
      headers: { authorization: 'Bearer safe' },
    })

    expect(created.statusCode).toBe(202)
    expect(fetched.statusCode).toBe(200)
    expect(artifact.statusCode).toBe(200)
    expect(artifact.rawPayload).toEqual(Buffer.from([1, 2, 3]))
    expect(taskService.create).toHaveBeenCalledTimes(1)
    await app.close()
  })
})
