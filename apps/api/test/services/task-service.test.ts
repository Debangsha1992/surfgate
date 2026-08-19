import { createHash } from 'node:crypto'

import {
  ArtifactIDSchema,
  APIKeyIDSchema,
  RequestIDSchema,
  SessionIDSchema,
  TaskIDSchema,
  TenantIDSchema,
} from '@surfgate/contracts'
import { ManagedTaskRecordSchema, type ManagedTaskCreateDraft } from '@surfgate/task-core'
import { describe, expect, it, vi } from 'vitest'

import { TaskService } from '../../src/services/task-service.js'

const tenantID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const sessionID = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const taskID = TaskIDSchema.parse('tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const artifactID = ArtifactIDSchema.parse('art_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const context = {
  tenantID,
  apiKeyID: APIKeyIDSchema.parse('key_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  requestID: RequestIDSchema.parse('req_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  scopes: ['tasks:write'] as const,
}
const TASK_CONFIG = {
  requestsPerMinute: 120,
  maxQueuedPerTenant: 100,
  maxRunningPerTenant: 5,
  maxAttempts: 3,
  executionTimeoutMs: 30_000,
  leaseTTLms: 60_000,
  pollIntervalMs: 250,
  extractMaxBytes: 1_048_576,
  artifactMaxBytes: 16_777_216,
  screenshotMaxPixels: 33_554_432,
  artifactRetentionSeconds: 86_400,
} as const

function fixture(
  capabilitiesForRuntime = () =>
    ({
      javascript: 'supported',
      dom: 'supported',
      xhr: 'supported',
      svg: 'supported',
      screenshot: 'supported',
      pdf: 'supported',
      webgl: 'supported',
      video: 'unknown',
      persistentAuth: 'supported',
      realBrowserTLS: 'supported',
      downloads: 'unknown',
      uploads: 'unknown',
      multiTab: 'supported',
      longSession: 'supported',
    }) as const,
  telemetry?: Readonly<{
    recordTask: ReturnType<typeof vi.fn>
    setActiveTasks: ReturnType<typeof vi.fn>
    captureTraceContext?: () => Readonly<{ traceparent: string }>
  }>,
) {
  const sessions = {
    findSessionForTenant: vi.fn().mockResolvedValue({
      id: sessionID,
      tenantID,
      status: 'active',
      selectedRuntime: 'chromium',
      expiresAt: '2026-08-10T01:00:00.000Z',
    }),
  }
  const tasks = {
    findIdempotentTask: vi.fn().mockResolvedValue(null),
    createIdempotent: vi.fn((input: { task: ManagedTaskCreateDraft }) =>
      Promise.resolve({
        kind: 'created' as const,
        task: ManagedTaskRecordSchema.parse({
          ...input.task,
          createdAt: '2026-08-10T00:00:00.000Z',
          updatedAt: '2026-08-10T00:00:00.000Z',
        }),
      }),
    ),
  }
  const audit = { append: vi.fn().mockResolvedValue(undefined) }
  const service = new TaskService({
    sessions,
    tasks: tasks as never,
    audit,
    capabilitiesForRuntime,
    config: TASK_CONFIG,
    ids: { task: () => taskID },
    now: () => new Date('2026-08-10T00:00:00.000Z'),
    ...(telemetry === undefined ? {} : { telemetry }),
  })
  return { service, tasks, sessions, audit }
}

describe('TaskService', () => {
  it('creates one queued provider-neutral task', async () => {
    const { service, tasks } = fixture()
    const response = await service.create(context, sessionID, { type: 'extract' }, 'task-key')

    expect(response.task).toMatchObject({ id: taskID, status: 'queued', type: 'extract' })
    expect(tasks.createIdempotent).toHaveBeenCalledTimes(1)
  })

  it('captures only a bounded W3C trace reference for asynchronous worker correlation', async () => {
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    const telemetry = {
      recordTask: vi.fn(),
      setActiveTasks: vi.fn(),
      captureTraceContext: () => ({ traceparent }),
    }
    const { service, tasks } = fixture(undefined, telemetry)

    await service.create(context, sessionID, { type: 'extract' }, 'trace-key')

    expect(tasks.createIdempotent.mock.calls[0]?.[0].task.traceParent).toBe(traceparent)
  })

  it('replays the durable task before mutable session-state checks', async () => {
    const { service, tasks, sessions } = fixture()
    const existing = ManagedTaskRecordSchema.parse({
      id: taskID,
      tenantID,
      sessionID,
      request: { type: 'extract', allowExperimental: false },
      status: 'queued',
      attemptCount: 0,
      maxAttempts: 3,
      result: null,
      failureCode: null,
      createdAt: '2026-08-09T23:00:00.000Z',
      updatedAt: '2026-08-09T23:00:00.000Z',
      startedAt: null,
      completedAt: null,
      failedAt: null,
      nextAttemptAt: null,
      claimToken: null,
      leaseExpiresAt: null,
      version: 0,
    })
    tasks.findIdempotentTask.mockResolvedValueOnce({ kind: 'existing', task: existing })

    const response = await service.create(context, sessionID, { type: 'extract' }, 'task-key')

    expect(response.task.id).toBe(taskID)
    expect(sessions.findSessionForTenant).not.toHaveBeenCalled()
    expect(tasks.createIdempotent).not.toHaveBeenCalled()
  })

  it('rejects PDF when the active runtime lacks support without rerouting', async () => {
    const { service, tasks } = fixture(() => ({ pdf: 'unsupported' }) as never)

    await expect(
      service.create(context, sessionID, { type: 'pdf' }, 'pdf-key'),
    ).rejects.toMatchObject({ code: 'TASK_UNSUPPORTED' })
    expect(tasks.createIdempotent).not.toHaveBeenCalled()
  })

  it('returns stable conflict and quota errors without exposing internals', async () => {
    const conflict = fixture()
    conflict.tasks.createIdempotent.mockResolvedValueOnce({ kind: 'conflict' } as never)
    await expect(
      conflict.service.create(context, sessionID, { type: 'extract' }, 'same-key'),
    ).rejects.toMatchObject({ code: 'VALIDATION_IDEMPOTENCY_CONFLICT', statusCode: 409 })

    const quota = fixture()
    quota.tasks.createIdempotent.mockResolvedValueOnce({ kind: 'quota_exceeded' } as never)
    await expect(
      quota.service.create(context, sessionID, { type: 'extract' }, 'quota-key'),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', statusCode: 429 })
    expect(quota.audit.append).not.toHaveBeenCalled()
  })

  it('fails tenant-safe when the session cannot be found or is expired', async () => {
    const missing = fixture()
    missing.sessions.findSessionForTenant.mockResolvedValueOnce(null)
    await expect(
      missing.service.create(context, sessionID, { type: 'extract' }, 'missing-key'),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND', statusCode: 404 })

    const expired = fixture()
    expired.sessions.findSessionForTenant.mockResolvedValueOnce({
      tenantID,
      id: sessionID,
      status: 'active',
      selectedRuntime: 'chromium',
      expiresAt: '2026-08-09T23:59:59.000Z',
    })
    expired.tasks.createIdempotent.mockResolvedValueOnce({ kind: 'session_expired' } as never)
    await expect(
      expired.service.create(context, sessionID, { type: 'extract' }, 'expired-key'),
    ).rejects.toMatchObject({ code: 'SESSION_EXPIRED', statusCode: 409 })
  })

  it('authorizes artifact bytes by tenant and hides the internal storage key', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const tasks = {
      findArtifactForTenant: vi.fn().mockResolvedValue({
        id: artifactID,
        tenantID,
        taskID,
        sessionID,
        mediaType: 'image/png',
        byteSize: bytes.byteLength,
        storageKey: `v1/${tenantID}/${taskID}/${artifactID}/a1-0123456789abcdef`,
        sha256,
        createdAt: '2026-08-10T00:00:00.000Z',
        expiresAt: '2026-08-11T00:00:00.000Z',
      }),
    }
    const service = new TaskService({
      sessions: {} as never,
      tasks: tasks as never,
      audit: { append: vi.fn().mockResolvedValue(undefined) },
      capabilitiesForRuntime: () => undefined,
      config: TASK_CONFIG,
      storage: { get: vi.fn().mockResolvedValue({ bytes, mediaType: 'image/png' }) } as never,
      now: () => new Date('2026-08-10T01:00:00.000Z'),
    })

    const result = await service.getArtifact(context, artifactID)
    expect(result.metadata.id).toBe(artifactID)
    expect(result).not.toHaveProperty('storageKey')
    expect(tasks.findArtifactForTenant).toHaveBeenCalledWith(tenantID, artifactID)
  })
})
