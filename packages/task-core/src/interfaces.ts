import type {
  APIKeyID,
  ArtifactID,
  ManagedTaskCreateRequest,
  ManagedTaskResult,
  PublicArtifact,
  RequestID,
  SessionID,
  TaskFailureCode,
  TaskID,
  TenantID,
} from '@surfgate/contracts'
import {
  PublicArtifactSchema,
  SessionIDSchema,
  TaskIDSchema,
  TenantIDSchema,
} from '@surfgate/contracts'
import type { ProviderSession, ResolvedProviderConnection } from '@surfgate/provider-core'
import { z } from 'zod'

import type { ManagedTaskRecord } from './task-state.js'

export type TaskTransitionCommand =
  | Readonly<{ type: 'succeed'; result: ManagedTaskResult }>
  | Readonly<{ type: 'schedule_retry'; retryDelayMs: number; failureCode: TaskFailureCode }>
  | Readonly<{ type: 'fail'; failureCode: TaskFailureCode }>
  | Readonly<{ type: 'cancel' }>

export type TaskCreateClaim =
  | Readonly<{ kind: 'created' | 'existing'; task: ManagedTaskRecord }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'quota_exceeded' }>
  | Readonly<{ kind: 'session_not_found' }>
  | Readonly<{ kind: 'session_expired' }>
  | Readonly<{ kind: 'session_not_active' }>

export type ManagedTaskCreateDraft = Omit<ManagedTaskRecord, 'createdAt' | 'updatedAt'>

export interface ManagedTaskRepository {
  findIdempotentTask(
    input: Readonly<{
      tenantID: TenantID
      sessionID: SessionID
      idempotencyKey: string
      requestHash: string
    }>,
  ): Promise<
    Readonly<{ kind: 'existing'; task: ManagedTaskRecord }> | Readonly<{ kind: 'conflict' }> | null
  >
  createIdempotent(
    input: Readonly<{
      tenantID: TenantID
      sessionID: SessionID
      idempotencyKey: string
      requestHash: string
      requestID: RequestID
      apiKeyID: APIKeyID
      task: ManagedTaskCreateDraft
      maxQueuedTasks: number
      maxTasksPerMinute: number
    }>,
  ): Promise<TaskCreateClaim>
  findTaskForTenant(tenantID: TenantID, taskID: TaskID): Promise<ManagedTaskRecord | null>
  transition(
    input: Readonly<{
      tenantID: TenantID
      taskID: TaskID
      expectedVersion: number
      expectedClaimToken?: string
      event: TaskTransitionCommand
    }>,
  ): Promise<ManagedTaskRecord>
  claimNext(
    input: Readonly<{
      claimToken: string
      leaseTTLms: number
      maxRunningPerTenant: number
    }>,
  ): Promise<ManagedTaskRecord | null>
  findExecutionSession(tenantID: TenantID, sessionID: SessionID): Promise<ManagedTaskSession | null>
  insertArtifactAndComplete(
    input: Readonly<{
      task: ManagedTaskRecord
      claimToken: string
      artifact: Omit<ArtifactRecord, 'createdAt' | 'expiresAt'>
      artifactRetentionSeconds: number
    }>,
  ): Promise<ManagedTaskRecord>
  findArtifactForTenant(tenantID: TenantID, artifactID: ArtifactID): Promise<ArtifactRecord | null>
}

export type ManagedTaskSession = Readonly<{
  tenantID: TenantID
  sessionID: SessionID
  status: string
  selectedRuntime: string | null
  expiresAt: string | null
  remainingLifetimeMs: number
  providerSessionReferenceEncrypted: string | null
}>

export const ArtifactRecordSchema = PublicArtifactSchema.unwrap()
  .extend({
    tenantID: TenantIDSchema,
    taskID: TaskIDSchema,
    sessionID: SessionIDSchema,
    storageKey: z
      .string()
      .regex(
        /^v1\/ten_[0-7][0-9A-HJKMNP-TV-Z]{25}\/tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}\/art_[0-7][0-9A-HJKMNP-TV-Z]{25}\/a[1-9][0-9]?-[0-9a-f]{16}$/u,
      ),
  })
  .strict()
  .readonly()
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>

export interface ArtifactStorage {
  put(
    input: Readonly<{
      key: string
      mediaType: PublicArtifact['mediaType']
      bytes: Uint8Array
      sha256: string
    }>,
    signal: AbortSignal,
  ): Promise<void>
  get(
    key: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Readonly<{ bytes: Uint8Array; mediaType: string }> | null>
  delete(key: string, signal: AbortSignal): Promise<void>
}

export type TaskExecutionOutput =
  | Readonly<{ type: 'extract'; title: string; text: string }>
  | Readonly<{
      type: 'screenshot' | 'pdf'
      mediaType: PublicArtifact['mediaType']
      bytes: Uint8Array
    }>

export interface ManagedBrowserExecutor {
  execute(
    input: Readonly<{
      request: ManagedTaskCreateRequest
      connection: ResolvedProviderConnection
      timeoutMs: number
      maxOutputBytes: number
      maxScreenshotPixels: number
      signal: AbortSignal
    }>,
  ): Promise<TaskExecutionOutput>
}

export interface ManagedTaskConnectionResolver {
  resolve(
    input: Readonly<{
      tenantID: TenantID
      sessionID: SessionID
      protectedReference: string
      expectedRuntime: string
      expectedExpiresAt: string
    }>,
  ): Readonly<{ session: ProviderSession; connection: ResolvedProviderConnection }>
}

export class ManagedTaskExecutionError extends Error {
  readonly code: TaskFailureCode
  readonly retryable: boolean

  constructor(code: TaskFailureCode, retryable: boolean) {
    super('The managed task could not be completed.')
    this.name = 'ManagedTaskExecutionError'
    this.code = code
    this.retryable = retryable
  }
}
