import {
  ManagedTaskExecutionError,
  ManagedTaskRecordSchema,
  TaskTransitionError,
  type ArtifactStorage,
  type ManagedBrowserExecutor,
  type ManagedTaskRecord,
  type ManagedTaskRepository,
} from '@surfgate/task-core'
import { KITESURF_CAPABILITIES } from '@surfgate/provider-kitesurf'
import { describe, expect, it, vi } from 'vitest'

import { ManagedTaskWorker } from '../src/managed-task-worker.js'

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

const task = ManagedTaskRecordSchema.parse({
  id: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  tenantID: 'ten_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  sessionID: 'ses_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  request: { type: 'extract' },
  status: 'running',
  attemptCount: 1,
  maxAttempts: 3,
  result: null,
  failureCode: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:01.000Z',
  startedAt: '2026-08-10T00:00:01.000Z',
  completedAt: null,
  failedAt: null,
  nextAttemptAt: null,
  claimToken: 'claim_01234567890123456789012345678901',
  leaseExpiresAt: '2026-08-10T00:01:01.000Z',
  version: 1,
})

const CAPABILITIES = {
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
} as const

function fixture(
  claimed: ManagedTaskRecord = task,
  executeImplementation: ManagedBrowserExecutor['execute'] = () =>
    Promise.resolve({
      type: 'extract',
      title: 'Title',
      text: 'private page text',
    }),
  executionDeadline?: (timeoutMs: number) => AbortSignal,
) {
  const execute = vi.fn(executeImplementation)
  const repository = {
    claimNext: vi.fn().mockResolvedValue(claimed),
    findExecutionSession: vi.fn().mockResolvedValue({
      tenantID: claimed.tenantID,
      sessionID: claimed.sessionID,
      status: 'active',
      selectedRuntime: 'chromium',
      expiresAt: '2026-08-10T01:00:00.000Z',
      remainingLifetimeMs: 3_600_000,
      providerSessionReferenceEncrypted: 'protected',
    }),
    transition: vi
      .fn<ManagedTaskRepository['transition']>()
      .mockImplementation(() => Promise.resolve(claimed)),
    insertArtifactAndComplete: vi.fn().mockResolvedValue({ ...claimed, status: 'succeeded' }),
  }
  const storage = {
    put: vi.fn<ArtifactStorage['put']>().mockResolvedValue(undefined),
    get: vi.fn<ArtifactStorage['get']>().mockResolvedValue(null),
    delete: vi.fn<ArtifactStorage['delete']>().mockResolvedValue(undefined),
  }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const worker = new ManagedTaskWorker({
    repository: repository as never,
    executor: { execute },
    storage,
    resolver: {
      resolve: () => ({
        session: {} as never,
        connection: { endpoint: 'wss://example.test', headers: {} },
      }),
    },
    capabilitiesForRuntime: () => CAPABILITIES,
    config: TASK_CONFIG,
    claimToken: () => claimed.claimToken!,
    ...(executionDeadline === undefined ? {} : { executionDeadline }),
    logger,
  })
  return { worker, repository, execute, storage, logger }
}

describe('ManagedTaskWorker', () => {
  it('claims and completes a bounded extraction without logging page content', async () => {
    const { worker, repository, logger } = fixture()

    expect(await worker.runOnce()).toBe(true)
    expect(repository.transition.mock.calls[0]?.[0].event.type).toBe('succeed')
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('private page text')
  })

  it('persists a bounded retry for a transient execution failure', async () => {
    const execute: ManagedBrowserExecutor['execute'] = () =>
      Promise.reject(new ManagedTaskExecutionError('TASK_EXECUTION_FAILED', true))
    const { worker, repository } = fixture(task, execute)

    await worker.runOnce()

    expect(repository.transition.mock.calls[0]?.[0].event).toMatchObject({
      type: 'schedule_retry',
      failureCode: 'TASK_EXECUTION_FAILED',
    })
  })

  it('does not retry unsupported capability or execute against an unknown runtime', async () => {
    const { repository, execute, storage } = fixture()
    const unknownCapabilitiesWorker = new ManagedTaskWorker({
      repository: repository as never,
      executor: { execute },
      storage,
      resolver: { resolve: () => ({ session: {} as never, connection: {} as never }) },
      capabilitiesForRuntime: () => undefined,
      config: TASK_CONFIG,
      claimToken: () => task.claimToken!,
    })

    await unknownCapabilitiesWorker.runOnce()

    expect(execute).not.toHaveBeenCalled()
    expect(repository.transition.mock.calls[0]?.[0].event).toMatchObject({
      type: 'fail',
      failureCode: 'TASK_UNSUPPORTED',
    })
  })

  it('fails closed when capability resolution is omitted', () => {
    const { repository, execute, storage } = fixture()

    expect(
      () =>
        new ManagedTaskWorker({
          repository: repository as never,
          executor: { execute },
          storage,
          resolver: { resolve: () => ({ session: {} as never, connection: {} as never }) },
          config: TASK_CONFIG,
        } as never),
    ).toThrow('capability')
  })

  it('rejects default PDF execution on Kitesurf without resolving or rerouting', async () => {
    const pdfTask = ManagedTaskRecordSchema.parse({ ...task, request: { type: 'pdf' } })
    const { repository, execute, storage } = fixture(pdfTask)
    repository.findExecutionSession.mockResolvedValueOnce({
      tenantID: pdfTask.tenantID,
      sessionID: pdfTask.sessionID,
      status: 'active',
      selectedRuntime: 'kitesurf',
      expiresAt: '2026-08-10T01:00:00.000Z',
      remainingLifetimeMs: 3_600_000,
      providerSessionReferenceEncrypted: 'protected',
    })
    const resolve = vi.fn()
    const worker = new ManagedTaskWorker({
      repository: repository as never,
      executor: { execute },
      storage,
      resolver: { resolve },
      capabilitiesForRuntime: () => KITESURF_CAPABILITIES,
      config: TASK_CONFIG,
      claimToken: () => pdfTask.claimToken!,
    })

    await worker.runOnce()

    expect(resolve).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(repository.transition.mock.calls[0]?.[0].event).toMatchObject({
      type: 'fail',
      failureCode: 'TASK_UNSUPPORTED',
    })
  })

  it('stores screenshot bytes under a deterministic private key before completing', async () => {
    const screenshotTask = ManagedTaskRecordSchema.parse({
      ...task,
      request: { type: 'screenshot', format: 'png' },
    })
    const execute: ManagedBrowserExecutor['execute'] = () =>
      Promise.resolve({
        type: 'screenshot',
        mediaType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
      })
    const { worker, repository, storage } = fixture(screenshotTask, execute)

    await worker.runOnce()

    const upload = storage.put.mock.calls[0]
    expect(upload).toBeDefined()
    expect(upload?.[0].mediaType).toBe('image/png')
    expect(upload?.[0].key).toMatch(
      new RegExp(`^v1/${task.tenantID}/${task.id}/art_${task.id.slice(4)}/a1-[0-9a-f]{16}$`),
    )
    expect(upload?.[1]).toBeInstanceOf(AbortSignal)
    expect(repository.insertArtifactAndComplete).toHaveBeenCalledTimes(1)
  })

  it('cleans an attempt-unique artifact after losing claim ownership', async () => {
    const screenshotTask = ManagedTaskRecordSchema.parse({
      ...task,
      request: { type: 'screenshot', format: 'png' },
    })
    const { worker, repository, storage } = fixture(screenshotTask, () =>
      Promise.resolve({
        type: 'screenshot',
        mediaType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
      }),
    )
    repository.insertArtifactAndComplete.mockRejectedValueOnce(new TaskTransitionError())

    await expect(worker.runOnce()).resolves.toBe(true)

    const uploadedKey = storage.put.mock.calls[0]?.[0].key
    expect(storage.delete).toHaveBeenCalledWith(uploadedKey, expect.any(AbortSignal))
    expect(repository.transition).not.toHaveBeenCalled()
  })

  it('treats stale completion and failure transitions as lost ownership, not worker failure', async () => {
    const { worker, repository } = fixture()
    repository.transition.mockRejectedValue(new TaskTransitionError())

    await expect(worker.runOnce()).resolves.toBe(true)
  })

  it('classifies contract-sized extraction overflow as non-retryable', async () => {
    const { worker, repository } = fixture(task, () =>
      Promise.resolve({ type: 'extract', title: 'x'.repeat(8_193), text: '' }),
    )

    await worker.runOnce()

    expect(repository.transition.mock.calls[0]?.[0].event).toMatchObject({
      type: 'fail',
      failureCode: 'TASK_OUTPUT_TOO_LARGE',
    })
  })

  it('propagates shutdown cancellation and leaves the lease recoverable', async () => {
    const finalAttempt = ManagedTaskRecordSchema.parse({ ...task, attemptCount: 3, maxAttempts: 3 })
    const execute: ManagedBrowserExecutor['execute'] = (input) => {
      expect(input.signal.aborted).toBe(true)
      return Promise.reject(new ManagedTaskExecutionError('TASK_CANCELLED', false))
    }
    const { worker, repository } = fixture(finalAttempt, execute)
    const controller = new AbortController()
    controller.abort()

    await worker.runOnce(controller.signal)

    expect(repository.transition).not.toHaveBeenCalled()
  })

  it('starts the execution deadline before session lookup and never runs after it expires', async () => {
    const deadline = new AbortController()
    let resolveLookup: (() => void) | undefined
    const { worker, repository, execute } = fixture(task, undefined, () => deadline.signal)
    repository.findExecutionSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLookup = () =>
            resolve({
              tenantID: task.tenantID,
              sessionID: task.sessionID,
              status: 'active',
              selectedRuntime: 'chromium',
              expiresAt: '2026-08-10T01:00:00.000Z',
              remainingLifetimeMs: 3_600_000,
              providerSessionReferenceEncrypted: 'protected',
            })
        }),
    )

    const run = worker.runOnce()
    await vi.waitFor(() => expect(repository.findExecutionSession).toHaveBeenCalledOnce())
    deadline.abort(new DOMException('Timed out', 'TimeoutError'))
    resolveLookup?.()
    await run

    expect(execute).not.toHaveBeenCalled()
    expect(repository.transition.mock.calls[0]?.[0].event).toMatchObject({
      type: 'schedule_retry',
      failureCode: 'TASK_TIMEOUT',
    })
  })
})
