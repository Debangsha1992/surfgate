import {
  ProviderAllocateRequestSchema,
  ProviderDescriptorSchema,
  ProviderError,
  ProviderHealthSchema,
  ProviderOperationOptionsSchema,
  ProviderSessionRefSchema,
  ProviderSessionSchema,
  ProviderTerminationResultSchema,
  normalizeProviderError,
  throwIfProviderOperationAborted,
  type BrowserProvider,
  type ProviderAllocateRequest,
  type ProviderDescriptor,
  type ProviderErrorCode,
  type ProviderHealth,
  type ProviderOperation,
  type ProviderOperationOptions,
  type ProviderSession,
  type ProviderSessionRef,
  type ProviderTerminationResult,
} from '@surfgate/provider-core'

import { FAKE_NOW_EPOCH_MS, createFakeProviderDescriptor } from './fixtures.js'

export type FakeHealthBehavior = 'healthy' | 'degraded' | 'unavailable' | 'throw_unknown'

export type FakeAllocationBehavior =
  | 'success'
  | 'timeout'
  | 'configuration_error'
  | 'authorization_error'
  | 'rate_limited'
  | 'capacity_exhausted'
  | 'transient_failure'
  | 'unsupported'
  | 'connection_failure'
  | 'invalid_response'
  | 'throw_unknown'

export type FakeTerminationBehavior = 'success' | 'timeout' | 'failure' | 'throw_unknown'

export type FakeBrowserProviderConfig = Readonly<{
  descriptor: unknown
  health: Readonly<{
    behavior: FakeHealthBehavior
    delayMs: number
    thrownValue?: unknown
  }>
  allocation: Readonly<{
    behavior: FakeAllocationBehavior
    delayMs: number
    retryAfterMs: number
    thrownValue?: unknown
  }>
  termination: Readonly<{
    behavior: FakeTerminationBehavior
    delayMs: number
    thrownValue?: unknown
  }>
  nowEpochMs: number
}>

export type FakeBrowserProviderConfigOverrides = Readonly<{
  descriptor?: unknown
  health?: Readonly<{
    behavior?: FakeHealthBehavior
    delayMs?: number
    thrownValue?: unknown
  }>
  allocation?: Readonly<{
    behavior?: FakeAllocationBehavior
    delayMs?: number
    retryAfterMs?: number
    thrownValue?: unknown
  }>
  termination?: Readonly<{
    behavior?: FakeTerminationBehavior
    delayMs?: number
    thrownValue?: unknown
  }>
  nowEpochMs?: number
}>

export function createFakeProviderConfig(
  overrides: FakeBrowserProviderConfigOverrides = {},
): FakeBrowserProviderConfig {
  return Object.freeze({
    descriptor: overrides.descriptor ?? createFakeProviderDescriptor(),
    health: Object.freeze({
      behavior: overrides.health?.behavior ?? 'healthy',
      delayMs: overrides.health?.delayMs ?? 0,
      ...(overrides.health?.thrownValue === undefined
        ? {}
        : { thrownValue: overrides.health.thrownValue }),
    }),
    allocation: Object.freeze({
      behavior: overrides.allocation?.behavior ?? 'success',
      delayMs: overrides.allocation?.delayMs ?? 0,
      retryAfterMs: overrides.allocation?.retryAfterMs ?? 1_000,
      ...(overrides.allocation?.thrownValue === undefined
        ? {}
        : { thrownValue: overrides.allocation.thrownValue }),
    }),
    termination: Object.freeze({
      behavior: overrides.termination?.behavior ?? 'success',
      delayMs: overrides.termination?.delayMs ?? 0,
      ...(overrides.termination?.thrownValue === undefined
        ? {}
        : { thrownValue: overrides.termination.thrownValue }),
    }),
    nowEpochMs: overrides.nowEpochMs ?? FAKE_NOW_EPOCH_MS,
  })
}

const ALLOCATION_ERROR_CODES: Readonly<Partial<Record<FakeAllocationBehavior, ProviderErrorCode>>> =
  Object.freeze({
    configuration_error: 'PROVIDER_CONFIGURATION_ERROR',
    authorization_error: 'PROVIDER_AUTHORIZATION_ERROR',
    rate_limited: 'PROVIDER_RATE_LIMITED',
    capacity_exhausted: 'PROVIDER_CAPACITY_EXHAUSTED',
    transient_failure: 'PROVIDER_TRANSIENT_UPSTREAM_FAILURE',
    unsupported: 'PROVIDER_UNSUPPORTED',
    connection_failure: 'PROVIDER_CONNECTION_FAILED',
    invalid_response: 'PROVIDER_INVALID_RESPONSE',
  })

export class FakeBrowserProvider implements BrowserProvider {
  readonly #config: FakeBrowserProviderConfig
  readonly #descriptor: ProviderDescriptor
  readonly #activeSessionIDs = new Set<string>()
  #nextSessionSequence = 1

  constructor(config: FakeBrowserProviderConfig) {
    this.#config = config
    try {
      this.#descriptor = ProviderDescriptorSchema.parse(config.descriptor)
    } catch {
      throw new ProviderError({
        code: 'PROVIDER_INVALID_RESPONSE',
        operation: 'descriptor',
      })
    }
  }

  descriptor(): ProviderDescriptor {
    return this.#descriptor
  }

  async health(options: ProviderOperationOptions): Promise<ProviderHealth> {
    return this.#runBoundedOperation('health', this.#config.health.delayMs, options, () => {
      if (this.#config.health.behavior === 'throw_unknown') {
        throw normalizeProviderError(
          this.#config.health.thrownValue ?? new Error('fake health failure'),
          'health',
        )
      }

      if (!this.#descriptor.configured) {
        return ProviderHealthSchema.parse({
          status: 'unavailable',
          configured: false,
          diagnosticCode: 'PROVIDER_NOT_CONFIGURED',
          capacity: 'unknown',
          checkedAt: this.#nowISO(),
        })
      }

      const healthByBehavior = {
        healthy: {
          status: 'healthy',
          configured: true,
          diagnosticCode: 'PROVIDER_HEALTHY',
          capacity: 'available',
        },
        degraded: {
          status: 'degraded',
          configured: true,
          diagnosticCode: 'PROVIDER_DEGRADED',
          capacity: 'constrained',
        },
        unavailable: {
          status: 'unavailable',
          configured: true,
          diagnosticCode: 'PROVIDER_UNAVAILABLE',
          capacity: 'unknown',
        },
      } as const

      return ProviderHealthSchema.parse({
        ...healthByBehavior[this.#config.health.behavior],
        checkedAt: this.#nowISO(),
        latencyMs: this.#config.health.delayMs,
      })
    })
  }

  async allocate(
    request: ProviderAllocateRequest,
    options: ProviderOperationOptions,
  ): Promise<ProviderSession> {
    let validatedRequest: ProviderAllocateRequest
    try {
      validatedRequest = ProviderAllocateRequestSchema.parse(request)
    } catch {
      throw new ProviderError({ code: 'PROVIDER_INVALID_RESPONSE', operation: 'allocate' })
    }

    return this.#runBoundedOperation(
      'allocate',
      this.#config.allocation.delayMs,
      options,
      () => this.#allocate(validatedRequest),
      this.#config.allocation.behavior === 'timeout',
    )
  }

  async terminate(
    reference: ProviderSessionRef,
    options: ProviderOperationOptions,
  ): Promise<ProviderTerminationResult> {
    let validatedReference: ProviderSessionRef
    try {
      validatedReference = ProviderSessionRefSchema.parse(reference)
    } catch {
      throw new ProviderError({ code: 'PROVIDER_INVALID_RESPONSE', operation: 'terminate' })
    }

    return this.#runBoundedOperation(
      'terminate',
      this.#config.termination.delayMs,
      options,
      () => this.#terminate(validatedReference),
      this.#config.termination.behavior === 'timeout',
    )
  }

  #allocate(request: ProviderAllocateRequest): ProviderSession {
    if (!this.#descriptor.configured) {
      throw new ProviderError({ code: 'PROVIDER_CONFIGURATION_ERROR', operation: 'allocate' })
    }

    if (this.#config.allocation.behavior === 'throw_unknown') {
      throw normalizeProviderError(
        this.#config.allocation.thrownValue ?? new Error('fake allocation failure'),
        'allocate',
      )
    }

    const errorCode = ALLOCATION_ERROR_CODES[this.#config.allocation.behavior]
    if (errorCode !== undefined) {
      throw new ProviderError({
        code: errorCode,
        operation: 'allocate',
        ...(errorCode === 'PROVIDER_RATE_LIMITED'
          ? { retryAfterMs: this.#config.allocation.retryAfterMs }
          : {}),
      })
    }

    const sequence = String(this.#nextSessionSequence).padStart(6, '0')
    this.#nextSessionSequence += 1
    const providerSessionID = `fake-session-${sequence}`
    this.#activeSessionIDs.add(providerSessionID)

    return ProviderSessionSchema.parse({
      reference: {
        providerID: this.#descriptor.providerID,
        runtimeClass: this.#descriptor.runtimeClass,
        providerSessionID,
      },
      connection: {
        transport: 'websocket',
        endpoint: `wss://browser.example.test/session/${providerSessionID}`,
        credentialReference: `fake-credential-ref-${sequence}`,
      },
      allocatedAt: this.#nowISO(),
      expiresAt: new Date(this.#config.nowEpochMs + request.maxSessionDurationMs).toISOString(),
      metadata: {
        ...(this.#descriptor.region === undefined ? {} : { region: this.#descriptor.region }),
        ...(this.#descriptor.configProfile === undefined
          ? {}
          : { configProfile: this.#descriptor.configProfile }),
        implementationVersion: this.#descriptor.implementation.version,
      },
    })
  }

  #terminate(reference: ProviderSessionRef): ProviderTerminationResult {
    if (this.#config.termination.behavior === 'throw_unknown') {
      throw normalizeProviderError(
        this.#config.termination.thrownValue ?? new Error('fake termination failure'),
        'terminate',
      )
    }
    if (this.#config.termination.behavior === 'failure') {
      throw new ProviderError({ code: 'PROVIDER_TERMINATION_FAILED', operation: 'terminate' })
    }

    const wasActive = this.#activeSessionIDs.delete(reference.providerSessionID)
    const status = wasActive ? 'terminated' : 'already_terminated'

    return ProviderTerminationResultSchema.parse({
      status,
      reference,
      terminatedAt: this.#nowISO(),
    })
  }

  #nowISO(): string {
    return new Date(this.#config.nowEpochMs).toISOString()
  }

  #runBoundedOperation<Result>(
    operation: ProviderOperation,
    delayMs: number,
    options: ProviderOperationOptions,
    action: () => Result,
    forceTimeout = false,
  ): Promise<Result> {
    const validatedOptions = ProviderOperationOptionsSchema.parse(options)
    throwIfProviderOperationAborted(validatedOptions.signal, operation)

    return new Promise<Result>((resolve, reject) => {
      let delayTimer: ReturnType<typeof setTimeout> | undefined
      let settled = false

      const cleanup = (): void => {
        clearTimeout(timeoutTimer)
        if (delayTimer !== undefined) {
          clearTimeout(delayTimer)
        }
        validatedOptions.signal?.removeEventListener('abort', onAbort)
      }
      const settle = (callback: () => void): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        callback()
      }
      const onAbort = (): void => {
        settle(() => {
          reject(new ProviderError({ code: 'PROVIDER_OPERATION_ABORTED', operation }))
        })
      }
      const execute = (): void => {
        try {
          const result = action()
          settle(() => {
            resolve(result)
          })
        } catch (error: unknown) {
          settle(() => {
            reject(normalizeProviderError(error, operation))
          })
        }
      }
      const timeoutTimer = setTimeout(() => {
        settle(() => {
          reject(new ProviderError({ code: 'PROVIDER_OPERATION_TIMEOUT', operation }))
        })
      }, validatedOptions.timeoutMs)

      validatedOptions.signal?.addEventListener('abort', onAbort, { once: true })

      if (!forceTimeout) {
        if (delayMs === 0) {
          execute()
        } else {
          delayTimer = setTimeout(execute, delayMs)
        }
      }
    })
  }
}
