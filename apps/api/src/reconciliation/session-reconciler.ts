import type { SessionID, TenantID } from '@surfgate/contracts'
import type { ProviderSessionReferenceProtector } from '@surfgate/security'

import type { Session, SessionTransitionEvent } from '../domain/session.js'
import type { ProviderRegistry } from '../providers/provider-registry.js'

export type SessionReconciliationCandidate = Readonly<{
  session: Session
  databaseNow: string
  uncertainAllocation: boolean
}>

export interface SessionReconciliationRepository {
  findReconciliationCandidates(
    input: Readonly<{
      staleAfterMs: number
      batchSize: number
    }>,
  ): Promise<readonly SessionReconciliationCandidate[]>
  transitionSessionForTenant(
    input: Readonly<{
      tenantID: TenantID
      sessionID: SessionID
      expectedVersion: number
      event: SessionTransitionEvent
    }>,
  ): Promise<Session>
  finalizeReconciledCreate(
    input: Readonly<{
      tenantID: TenantID
      sessionID: SessionID
      at: string
    }>,
  ): Promise<void>
  databaseNow(): Promise<string>
}

export type SessionReconciliationResult = Readonly<{
  inspected: number
  recovered: number
  unresolved: number
  suspectedProviderLeaks: number
}>

export class SessionReconciler {
  constructor(
    private readonly dependencies: Readonly<{
      sessions: SessionReconciliationRepository
      registry: ProviderRegistry
      protector: ProviderSessionReferenceProtector
      staleAfterMs: number
      batchSize: number
      terminationTimeoutMs: number
    }>,
  ) {}

  async runBatch(): Promise<SessionReconciliationResult> {
    const candidates = await this.dependencies.sessions.findReconciliationCandidates({
      staleAfterMs: this.dependencies.staleAfterMs,
      batchSize: this.dependencies.batchSize,
    })
    let recovered = 0
    let unresolved = 0
    let suspectedProviderLeaks = 0
    for (const candidate of candidates) {
      if (candidate.uncertainAllocation) suspectedProviderLeaks += 1
      try {
        if (await this.#reconcile(candidate)) recovered += 1
        else unresolved += 1
      } catch {
        unresolved += 1
      }
    }
    return Object.freeze({
      inspected: candidates.length,
      recovered,
      unresolved,
      suspectedProviderLeaks,
    })
  }

  async #reconcile(candidate: SessionReconciliationCandidate): Promise<boolean> {
    let session = candidate.session
    if (session.status === 'failed') {
      await this.dependencies.sessions.finalizeReconciledCreate({
        tenantID: session.tenantID,
        sessionID: session.id,
        at: candidate.databaseNow,
      })
      return true
    }
    if (['pending', 'routing', 'allocating', 'fallback_allocating'].includes(session.status)) {
      session = await this.dependencies.sessions.transitionSessionForTenant({
        tenantID: session.tenantID,
        sessionID: session.id,
        expectedVersion: session.version,
        event: {
          type: 'fail',
          at: candidate.databaseNow,
          reason: candidate.uncertainAllocation
            ? 'allocation_outcome_uncertain'
            : 'reconciliation_timeout',
        },
      })
      await this.dependencies.sessions.finalizeReconciledCreate({
        tenantID: session.tenantID,
        sessionID: session.id,
        at: candidate.databaseNow,
      })
      return true
    }

    if (session.status === 'active') {
      session = await this.dependencies.sessions.transitionSessionForTenant({
        tenantID: session.tenantID,
        sessionID: session.id,
        expectedVersion: session.version,
        event: { type: 'request_termination', at: candidate.databaseNow },
      })
    }
    if (session.status !== 'terminating' || session.providerSessionReferenceEncrypted === null) {
      return false
    }

    const protectedSession = this.dependencies.protector.decrypt(
      session.providerSessionReferenceEncrypted,
      { tenantID: session.tenantID, sessionID: session.id },
    )
    const provider = this.dependencies.registry.resolve(protectedSession.candidate)
    await provider.terminate(protectedSession.session.reference, {
      timeoutMs: this.dependencies.terminationTimeoutMs,
    })
    const completedAt = await this.dependencies.sessions.databaseNow()
    await this.dependencies.sessions.transitionSessionForTenant({
      tenantID: session.tenantID,
      sessionID: session.id,
      expectedVersion: session.version,
      event: {
        type: 'complete_termination',
        at: completedAt,
        reason: candidate.session.status === 'active' ? 'session_expired' : 'reconciled_cleanup',
      },
    })
    return true
  }
}
