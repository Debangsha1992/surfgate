import { createHash } from 'node:crypto'

import type { ManagedTaskConfig } from '@surfgate/config'
import {
  ArtifactIDSchema,
  IdempotencyKeySchema,
  normalizeManagedTaskCreateRequest,
  ManagedTaskResponseSchema,
  PublicArtifactSchema,
  SessionIDSchema,
  TaskIDSchema,
  type ArtifactID,
  type CapabilitySupportMap,
  type ManagedTask,
  type ManagedTaskCreateRequest,
  type SessionID,
  type TaskID,
} from '@surfgate/contracts'
import type {
  ArtifactStorage,
  ManagedTaskCreateDraft,
  ManagedTaskRecord,
  ManagedTaskRepository,
} from '@surfgate/task-core'
import { NOOP_MANAGED_TASK_TELEMETRY, type ManagedTaskTelemetry } from '@surfgate/observability'

import type { AuthenticatedTenantContext } from '../auth/context.js'
import type { AuditEventRepository } from '../domain/audit-event.js'
import { generateTaskID } from '../domain/opaque-id.js'
import { ControlPlaneHTTPError } from '../errors/http-error.js'
import type { SessionRepository } from '../repositories/session-repository.js'
import { hashIdempotentRequest } from './idempotency-hash.js'

type TaskServiceDependencies = Readonly<{
  sessions: Pick<SessionRepository, 'findSessionForTenant'>
  tasks: ManagedTaskRepository
  audit: AuditEventRepository
  capabilitiesForRuntime(runtimeClass: string): CapabilitySupportMap | undefined
  config: ManagedTaskConfig
  storage?: ArtifactStorage
  telemetry?: ManagedTaskTelemetry
  ids?: Readonly<{ task(): TaskID }>
  now?: () => Date
}>

function publicTask(task: ManagedTaskRecord): ManagedTask {
  return ManagedTaskResponseSchema.parse({
    task: {
      id: task.id,
      sessionId: task.sessionID,
      type: task.request.type,
      status: task.status,
      attemptCount: task.attemptCount,
      result: task.result,
      failureCode: task.failureCode,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      failedAt: task.failedAt,
      nextAttemptAt: task.nextAttemptAt,
    },
  }).task
}

function requiredCapabilities(
  request: ManagedTaskCreateRequest,
): readonly (keyof CapabilitySupportMap)[] {
  if (request.type === 'extract') return ['javascript', 'dom']
  return [request.type]
}

function supports(request: ManagedTaskCreateRequest, capabilities: CapabilitySupportMap): boolean {
  return requiredCapabilities(request).every((capability) => {
    const support = capabilities[capability]
    return (
      support === 'supported' || (support === 'experimental' && request.allowExperimental === true)
    )
  })
}

export class TaskService {
  readonly #now: () => Date
  readonly #ids: NonNullable<TaskServiceDependencies['ids']>

  constructor(private readonly dependencies: TaskServiceDependencies) {
    this.#now = dependencies.now ?? (() => new Date())
    this.#ids = dependencies.ids ?? { task: generateTaskID }
  }

  async create(
    context: AuthenticatedTenantContext,
    rawSessionID: SessionID,
    rawRequest: unknown,
    rawIdempotencyKey: string,
  ) {
    const startedAt = performance.now()
    const sessionID = SessionIDSchema.parse(rawSessionID)
    const request = normalizeManagedTaskCreateRequest(rawRequest)
    const idempotencyKey = IdempotencyKeySchema.parse(rawIdempotencyKey)
    const requestHash = hashIdempotentRequest(request)
    const replay = await this.dependencies.tasks.findIdempotentTask({
      tenantID: context.tenantID,
      sessionID,
      idempotencyKey,
      requestHash,
    })
    if (replay?.kind === 'conflict') {
      this.#record({
        event: 'create',
        taskType: request.type,
        outcome: 'failure',
        durationMs: performance.now() - startedAt,
        reasonCode: 'VALIDATION_IDEMPOTENCY_CONFLICT',
      })
      throw new ControlPlaneHTTPError('VALIDATION_IDEMPOTENCY_CONFLICT', 409)
    }
    if (replay?.kind === 'existing') {
      this.#record({
        event: 'create',
        taskType: request.type,
        outcome: 'success',
        durationMs: performance.now() - startedAt,
      })
      return ManagedTaskResponseSchema.parse({ task: publicTask(replay.task) })
    }
    const session = await this.dependencies.sessions.findSessionForTenant(
      context.tenantID,
      sessionID,
    )
    if (session === null) throw new ControlPlaneHTTPError('SESSION_NOT_FOUND', 404)
    if (session.status !== 'active') throw new ControlPlaneHTTPError('SESSION_NOT_ACTIVE', 409)
    const capabilities =
      session.selectedRuntime === null
        ? undefined
        : this.dependencies.capabilitiesForRuntime(session.selectedRuntime)
    if (capabilities === undefined || !supports(request, capabilities)) {
      throw new ControlPlaneHTTPError('TASK_UNSUPPORTED', 422)
    }
    const task: ManagedTaskCreateDraft = {
      id: this.#ids.task(),
      tenantID: context.tenantID,
      sessionID,
      request,
      status: 'queued',
      attemptCount: 0,
      maxAttempts: this.dependencies.config.maxAttempts,
      result: null,
      failureCode: null,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      nextAttemptAt: null,
      claimToken: null,
      leaseExpiresAt: null,
      version: 0,
    }
    const claim = await this.dependencies.tasks.createIdempotent({
      tenantID: context.tenantID,
      sessionID,
      idempotencyKey,
      requestHash,
      requestID: context.requestID,
      apiKeyID: context.apiKeyID,
      task,
      maxQueuedTasks: this.dependencies.config.maxQueuedPerTenant,
      maxTasksPerMinute: this.dependencies.config.requestsPerMinute,
    })
    if (claim.kind === 'conflict') {
      this.#record({
        event: 'create',
        taskType: request.type,
        outcome: 'failure',
        durationMs: performance.now() - startedAt,
        reasonCode: 'VALIDATION_IDEMPOTENCY_CONFLICT',
      })
      throw new ControlPlaneHTTPError('VALIDATION_IDEMPOTENCY_CONFLICT', 409)
    }
    if (claim.kind === 'quota_exceeded') {
      this.#record({
        event: 'create',
        taskType: request.type,
        outcome: 'failure',
        durationMs: performance.now() - startedAt,
        reasonCode: 'QUOTA_EXCEEDED',
      })
      throw new ControlPlaneHTTPError('QUOTA_EXCEEDED', 429)
    }
    if (claim.kind === 'session_not_found')
      throw new ControlPlaneHTTPError('SESSION_NOT_FOUND', 404)
    if (claim.kind === 'session_not_active')
      throw new ControlPlaneHTTPError('SESSION_NOT_ACTIVE', 409)
    if (claim.kind === 'session_expired') throw new ControlPlaneHTTPError('SESSION_EXPIRED', 409)
    const response = ManagedTaskResponseSchema.parse({ task: publicTask(claim.task) })
    this.#record({
      event: 'create',
      taskType: request.type,
      outcome: 'success',
      durationMs: performance.now() - startedAt,
    })
    return response
  }

  async get(context: AuthenticatedTenantContext, rawTaskID: TaskID) {
    const task = await this.dependencies.tasks.findTaskForTenant(
      context.tenantID,
      TaskIDSchema.parse(rawTaskID),
    )
    if (task === null) throw new ControlPlaneHTTPError('TASK_NOT_FOUND', 404)
    return ManagedTaskResponseSchema.parse({ task: publicTask(task) })
  }

  async getArtifact(context: AuthenticatedTenantContext, rawArtifactID: ArtifactID) {
    const artifact = await this.dependencies.tasks.findArtifactForTenant(
      context.tenantID,
      ArtifactIDSchema.parse(rawArtifactID),
    )
    if (artifact === null) throw new ControlPlaneHTTPError('ARTIFACT_NOT_FOUND', 404)
    if (Date.parse(artifact.expiresAt) <= this.#now().getTime()) {
      throw new ControlPlaneHTTPError('ARTIFACT_UNAVAILABLE', 410)
    }
    if (this.dependencies.storage === undefined)
      throw new ControlPlaneHTTPError('ARTIFACT_UNAVAILABLE', 503)
    let object: Awaited<ReturnType<ArtifactStorage['get']>>
    try {
      object = await this.dependencies.storage.get(
        artifact.storageKey,
        this.dependencies.config.artifactMaxBytes,
        AbortSignal.timeout(this.dependencies.config.executionTimeoutMs),
      )
    } catch {
      throw new ControlPlaneHTTPError('ARTIFACT_UNAVAILABLE', 503)
    }
    if (
      object === null ||
      object.mediaType !== artifact.mediaType ||
      object.bytes.byteLength !== artifact.byteSize ||
      createHash('sha256').update(object.bytes).digest('hex') !== artifact.sha256
    ) {
      throw new ControlPlaneHTTPError('ARTIFACT_UNAVAILABLE', 503)
    }
    await this.dependencies.audit.append({
      tenantID: context.tenantID,
      type: 'artifact.accessed',
      requestID: context.requestID,
      apiKeyID: context.apiKeyID,
      sessionID: artifact.sessionID,
      taskID: artifact.taskID,
      artifactID: artifact.id,
      createdAt: this.#now().toISOString(),
    })
    this.#record({
      event: 'artifact_access',
      outcome: 'success',
      durationMs: 0,
      bytes: object.bytes.byteLength,
    })
    return Object.freeze({
      metadata: PublicArtifactSchema.parse({
        id: artifact.id,
        mediaType: artifact.mediaType,
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
        createdAt: artifact.createdAt,
        expiresAt: artifact.expiresAt,
      }),
      bytes: object.bytes,
    })
  }

  #record(input: Parameters<ManagedTaskTelemetry['recordTask']>[0]): void {
    try {
      ;(this.dependencies.telemetry ?? NOOP_MANAGED_TASK_TELEMETRY).recordTask(input)
    } catch {
      // Telemetry is deliberately non-authoritative for task correctness.
    }
  }
}
