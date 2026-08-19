import { createHash, randomBytes } from 'node:crypto'

import type { ManagedTaskConfig } from '@surfgate/config'
import {
  NOOP_MANAGED_TASK_TELEMETRY,
  traceIDFromCarrier,
  type ManagedTaskTelemetry,
} from '@surfgate/observability'
import {
  ArtifactIDSchema,
  MAX_EXTRACT_TEXT_CHARACTERS,
  MAX_EXTRACT_TITLE_CHARACTERS,
  type CapabilitySupportMap,
  type ManagedTaskResult,
} from '@surfgate/contracts'
import {
  ManagedTaskExecutionError,
  TaskTransitionError,
  type ArtifactRecord,
  type ArtifactStorage,
  type ManagedBrowserExecutor,
  type ManagedTaskConnectionResolver,
  type ManagedTaskRecord,
  type ManagedTaskRepository,
} from '@surfgate/task-core'

export type WorkerLogger = Readonly<{
  info(fields: Readonly<Record<string, unknown>>, message: string): void
  warn(fields: Readonly<Record<string, unknown>>, message: string): void
  error(fields: Readonly<Record<string, unknown>>, message: string): void
}>
const NOOP_LOGGER: WorkerLogger = Object.freeze({ info() {}, warn() {}, error() {} })

type WorkerDependencies = Readonly<{
  repository: ManagedTaskRepository
  executor: ManagedBrowserExecutor
  storage: ArtifactStorage
  resolver: ManagedTaskConnectionResolver
  config: ManagedTaskConfig
  capabilitiesForRuntime(runtimeClass: string): CapabilitySupportMap | undefined
  claimToken?: () => string
  executionDeadline?: (timeoutMs: number) => AbortSignal
  logger?: WorkerLogger
  telemetry?: ManagedTaskTelemetry
}>

function artifactID(task: ManagedTaskRecord): ArtifactRecord['id'] {
  return ArtifactIDSchema.parse(`art_${task.id.slice(4)}`)
}
function storageKey(task: ManagedTaskRecord, id: ArtifactRecord['id'], claimToken: string): string {
  const claimDigest = createHash('sha256').update(claimToken).digest('hex').slice(0, 16)
  return `v1/${task.tenantID}/${task.id}/${id}/a${task.attemptCount}-${claimDigest}`
}
function requiredCapability(task: ManagedTaskRecord): readonly (keyof CapabilitySupportMap)[] {
  return task.request.type === 'extract' ? ['javascript', 'dom'] : [task.request.type]
}
function capabilityAllowed(task: ManagedTaskRecord, capabilities: CapabilitySupportMap): boolean {
  return requiredCapability(task).every((name) => {
    const support = capabilities[name]
    return (
      support === 'supported' ||
      (support === 'experimental' && task.request.allowExperimental === true)
    )
  })
}

export class ManagedTaskWorker {
  readonly #claimToken: () => string
  readonly #executionDeadline: (timeoutMs: number) => AbortSignal
  readonly #logger: WorkerLogger

  constructor(private readonly dependencies: WorkerDependencies) {
    if (typeof dependencies.capabilitiesForRuntime !== 'function') {
      throw new TypeError('Managed task capability resolution is required.')
    }
    this.#claimToken =
      dependencies.claimToken ?? (() => `claim_${randomBytes(32).toString('base64url')}`)
    this.#executionDeadline =
      dependencies.executionDeadline ?? ((timeoutMs) => AbortSignal.timeout(timeoutMs))
    this.#logger = dependencies.logger ?? NOOP_LOGGER
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<boolean> {
    const claimToken = this.#claimToken()
    const task = await this.dependencies.repository.claimNext({
      claimToken,
      leaseTTLms: this.dependencies.config.leaseTTLms,
      maxRunningPerTenant: this.dependencies.config.maxRunningPerTenant,
    })
    if (task === null) return false
    const executionDeadline = this.#executionDeadline(this.dependencies.config.executionTimeoutMs)
    const executionSignal = AbortSignal.any([signal, executionDeadline])
    const startedAt = performance.now()
    const telemetry = this.dependencies.telemetry ?? NOOP_MANAGED_TASK_TELEMETRY
    const taskSpan = telemetry.startSpan?.(
      'surfgate.task.execute',
      { taskType: task.request.type, attemptCount: task.attemptCount },
      task.traceParent === null ? undefined : { traceparent: task.traceParent },
    )
    const traceID = traceIDFromCarrier(taskSpan?.context())
    let taskOutcome: 'success' | 'failure' = 'failure'
    this.#setActiveTasks(1)
    this.#record({
      event: 'claim',
      taskType: task.request.type,
      outcome: 'success',
      durationMs: 0,
      queueLatencyMs: Math.max(0, Date.now() - Date.parse(task.createdAt)),
      attemptCount: task.attemptCount,
    })
    try {
      const execution = () =>
        this.#execute(task, claimToken, executionSignal, signal, executionDeadline)
      await (taskSpan === undefined ? execution() : taskSpan.run(execution))
      taskOutcome = 'success'
      this.#record({
        event: 'execute',
        taskType: task.request.type,
        outcome: 'success',
        durationMs: performance.now() - startedAt,
        attemptCount: task.attemptCount,
      })
      this.#logger.info(
        {
          event: 'task.execution.completed',
          taskType: task.request.type,
          outcome: 'success',
          attemptCount: task.attemptCount,
          traceID,
        },
        'Managed task completed',
      )
    } catch (error: unknown) {
      // During process shutdown, leave the bounded claim to expire so another worker can reclaim
      // it. Persisting a terminal cancellation would lose otherwise retryable work.
      if (error instanceof TaskTransitionError) {
        this.#logger.warn(
          {
            event: 'task.claim.lost',
            taskType: task.request.type,
            outcome: 'ignored',
            attemptCount: task.attemptCount,
          },
          'Managed task claim ownership was lost',
        )
      } else if (!signal.aborted) {
        await this.#handleFailure(task, claimToken, error, traceID)
      }
      const code = error instanceof ManagedTaskExecutionError ? error.code : 'TASK_EXECUTION_FAILED'
      this.#record({
        event: 'execute',
        taskType: task.request.type,
        outcome: 'failure',
        durationMs: performance.now() - startedAt,
        attemptCount: task.attemptCount,
        reasonCode: code,
      })
    } finally {
      taskSpan?.end(taskOutcome, { taskType: task.request.type, attemptCount: task.attemptCount })
      this.#setActiveTasks(0)
    }
    return true
  }

  async #execute(
    task: ManagedTaskRecord,
    claimToken: string,
    attemptSignal: AbortSignal,
    outerSignal: AbortSignal,
    executionDeadline: AbortSignal,
  ): Promise<void> {
    if (attemptSignal.aborted) {
      throw new ManagedTaskExecutionError(
        executionDeadline.aborted ? 'TASK_TIMEOUT' : 'TASK_CANCELLED',
        executionDeadline.aborted,
      )
    }
    const session = await this.dependencies.repository.findExecutionSession(
      task.tenantID,
      task.sessionID,
    )
    if (
      session === null ||
      session.status !== 'active' ||
      session.expiresAt === null ||
      session.remainingLifetimeMs <= 0 ||
      session.providerSessionReferenceEncrypted === null ||
      session.selectedRuntime === null
    ) {
      throw new ManagedTaskExecutionError('TASK_INVALID_STATE', false)
    }
    if (attemptSignal.aborted) {
      throw new ManagedTaskExecutionError(
        executionDeadline.aborted ? 'TASK_TIMEOUT' : 'TASK_CANCELLED',
        executionDeadline.aborted,
      )
    }
    const capabilities = this.dependencies.capabilitiesForRuntime(session.selectedRuntime)
    if (capabilities === undefined || !capabilityAllowed(task, capabilities)) {
      throw new ManagedTaskExecutionError('TASK_UNSUPPORTED', false)
    }
    const resolved = this.dependencies.resolver.resolve({
      tenantID: task.tenantID,
      sessionID: task.sessionID,
      protectedReference: session.providerSessionReferenceEncrypted,
      expectedRuntime: session.selectedRuntime,
      expectedExpiresAt: session.expiresAt,
    })
    const timeoutMs = Math.max(
      1,
      Math.min(this.dependencies.config.executionTimeoutMs, session.remainingLifetimeMs),
    )
    const sessionDeadline = this.#executionDeadline(timeoutMs)
    const signal = AbortSignal.any([attemptSignal, sessionDeadline])
    const output = await this.dependencies.executor.execute({
      request: task.request,
      connection: resolved.connection,
      timeoutMs,
      maxOutputBytes:
        task.request.type === 'extract'
          ? this.dependencies.config.extractMaxBytes
          : this.dependencies.config.artifactMaxBytes,
      maxScreenshotPixels: this.dependencies.config.screenshotMaxPixels,
      signal,
    })
    if (output.type === 'extract') {
      if (
        output.title.length > MAX_EXTRACT_TITLE_CHARACTERS ||
        output.text.length > MAX_EXTRACT_TEXT_CHARACTERS ||
        Buffer.byteLength(output.title) + Buffer.byteLength(output.text) >
          this.dependencies.config.extractMaxBytes
      ) {
        throw new ManagedTaskExecutionError('TASK_OUTPUT_TOO_LARGE', false)
      }
      const result: ManagedTaskResult = { type: 'extract', title: output.title, text: output.text }
      await this.dependencies.repository.transition({
        tenantID: task.tenantID,
        taskID: task.id,
        expectedVersion: task.version,
        expectedClaimToken: claimToken,
        event: { type: 'succeed', result },
      })
      return
    }
    if (output.bytes.byteLength > this.dependencies.config.artifactMaxBytes) {
      throw new ManagedTaskExecutionError('ARTIFACT_TOO_LARGE', false)
    }
    const id = artifactID(task)
    const sha256 = createHash('sha256').update(output.bytes).digest('hex')
    const artifact: Omit<ArtifactRecord, 'createdAt' | 'expiresAt'> = {
      id,
      tenantID: task.tenantID,
      taskID: task.id,
      sessionID: task.sessionID,
      mediaType: output.mediaType,
      byteSize: output.bytes.byteLength,
      storageKey: storageKey(task, id, claimToken),
      sha256,
    }
    const uploadStartedAt = performance.now()
    try {
      await this.dependencies.storage.put(
        {
          key: artifact.storageKey,
          mediaType: artifact.mediaType,
          bytes: output.bytes,
          sha256,
        },
        signal,
      )
      this.#record({
        event: 'artifact_upload',
        taskType: task.request.type,
        outcome: 'success',
        durationMs: performance.now() - uploadStartedAt,
        attemptCount: task.attemptCount,
        bytes: output.bytes.byteLength,
      })
    } catch {
      this.#record({
        event: 'artifact_upload',
        taskType: task.request.type,
        outcome: 'failure',
        durationMs: Math.max(0, performance.now() - uploadStartedAt),
        attemptCount: task.attemptCount,
        reasonCode: 'ARTIFACT_STORAGE_FAILED',
      })
      if (executionDeadline.aborted || sessionDeadline.aborted) {
        throw new ManagedTaskExecutionError('TASK_TIMEOUT', true)
      }
      if (outerSignal.aborted) throw new ManagedTaskExecutionError('TASK_CANCELLED', false)
      throw new ManagedTaskExecutionError('ARTIFACT_STORAGE_FAILED', true)
    }
    try {
      await this.dependencies.repository.insertArtifactAndComplete({
        task,
        claimToken,
        artifact,
        artifactRetentionSeconds: this.dependencies.config.artifactRetentionSeconds,
      })
    } catch (error: unknown) {
      if (error instanceof TaskTransitionError) {
        try {
          await this.dependencies.storage.delete(
            artifact.storageKey,
            AbortSignal.timeout(Math.min(5_000, this.dependencies.config.executionTimeoutMs)),
          )
        } catch {
          this.#logger.warn(
            {
              event: 'artifact.cleanup.failed',
              taskType: task.request.type,
              outcome: 'failure',
              reasonCode: 'ARTIFACT_STORAGE_FAILED',
              attemptCount: task.attemptCount,
            },
            'Managed task artifact cleanup failed',
          )
        }
      }
      throw error
    }
  }

  async #handleFailure(
    task: ManagedTaskRecord,
    claimToken: string,
    error: unknown,
    traceID: string | undefined,
  ): Promise<void> {
    const normalized =
      error instanceof ManagedTaskExecutionError
        ? error
        : new ManagedTaskExecutionError('TASK_EXECUTION_FAILED', true)
    const retry = normalized.retryable && task.attemptCount < task.maxAttempts
    try {
      await this.dependencies.repository.transition({
        tenantID: task.tenantID,
        taskID: task.id,
        expectedVersion: task.version,
        expectedClaimToken: claimToken,
        event: retry
          ? {
              type: 'schedule_retry',
              failureCode: normalized.code,
              retryDelayMs: Math.min(30_000, 1_000 * 2 ** Math.max(0, task.attemptCount - 1)),
            }
          : { type: 'fail', failureCode: normalized.code },
      })
    } catch (error: unknown) {
      if (!(error instanceof TaskTransitionError)) throw error
      this.#logger.warn(
        {
          event: 'task.claim.lost',
          taskType: task.request.type,
          outcome: 'ignored',
          attemptCount: task.attemptCount,
          traceID,
        },
        'Managed task claim ownership was lost',
      )
      return
    }
    this.#logger.warn(
      {
        event: retry ? 'task.retry.scheduled' : 'task.execution.failed',
        taskType: task.request.type,
        outcome: 'failure',
        reasonCode: normalized.code,
        attemptCount: task.attemptCount,
        traceID,
      },
      retry ? 'Managed task retry scheduled' : 'Managed task failed',
    )
    if (retry) {
      this.#record({
        event: 'retry',
        taskType: task.request.type,
        outcome: 'success',
        durationMs: 0,
        attemptCount: task.attemptCount,
        reasonCode: normalized.code,
      })
    }
  }

  #record(input: Parameters<ManagedTaskTelemetry['recordTask']>[0]): void {
    try {
      ;(this.dependencies.telemetry ?? NOOP_MANAGED_TASK_TELEMETRY).recordTask(input)
    } catch {
      // Telemetry cannot own task lifecycle correctness.
    }
  }

  #setActiveTasks(value: number): void {
    try {
      ;(this.dependencies.telemetry ?? NOOP_MANAGED_TASK_TELEMETRY).setActiveTasks(value)
    } catch {
      // Telemetry cannot own task lifecycle correctness.
    }
  }
}
