import type { CloudflareConfig } from '@surfgate/config'
import {
  CAPABILITY_NAMES,
  CapabilitySupportMapSchema,
  satisfiesCapabilityRequirement,
  type CapabilitySupportMap,
} from '@surfgate/contracts'
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
  type ProviderOperationOptions,
  type ProviderSession,
  type ProviderSessionRef,
  type ProviderTerminationResult,
} from '@surfgate/provider-core'
import { z } from 'zod'

import {
  CloudflareBrowserRunTransport,
  type CloudflareAPINamespace,
} from './cloudflare-browser-run-transport.js'

const MAX_CREATE_RESPONSE_BYTES = 16 * 1_024
const MAX_HEALTH_RESPONSE_BYTES = 128 * 1_024
const MAX_TERMINATE_RESPONSE_BYTES = 4 * 1_024
const MAX_RECENTLY_TERMINATED_SESSIONS = 64
const RECENT_TERMINATION_TTL_MS = 10 * 60 * 1_000
const MAX_ALLOCATION_CLEANUP_TIMEOUT_MS = 5_000
const MIN_CLOUDFLARE_KEEP_ALIVE_MS = 10_000

const CloudflareCreateSessionResponseSchema = z
  .object({
    sessionId: z.uuid(),
    webSocketDebuggerUrl: z.string().url(),
  })
  .strict()
  .readonly()

const CloudflareCreateSessionIdentitySchema = z
  .object({ sessionId: z.uuid() })
  .passthrough()
  .readonly()

const CloudflareHealthResponseSchema = z
  .array(z.object({ sessionId: z.uuid() }).passthrough().readonly())
  .max(200)
  .readonly()

const CloudflareTerminationResponseSchema = z
  .object({ status: z.enum(['closing', 'closed']) })
  .strict()
  .readonly()

export type CloudflareBrowserRunProfile = Readonly<{
  apiNamespace: CloudflareAPINamespace
  acceptedConnectionNamespaces: readonly CloudflareAPINamespace[]
  browserSelector?: string
  runtimeClass: 'kitesurf' | 'chromium'
  displayName: string
  capabilities: CapabilitySupportMap
  implementationName: string
  implementationVersion: string
  configProfile: string
  maximumKeepAliveMs: number
  maximumSessionDurationMs?: number
}>

export type CloudflareProviderOptions = Readonly<{
  fetch?: typeof fetch
  now?: () => Date
  monotonicNow?: () => number
}>

async function parseBoundedJSON(response: Response, maximumBytes: number): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) {
    throw new TypeError('Missing response body')
  }
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const result = (await reader.read()) as Readonly<{ done: boolean; value?: unknown }>
      if (result.done) {
        break
      }
      const chunk = result.value
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError('Response body returned a non-byte chunk')
      }
      totalBytes += chunk.byteLength
      if (totalBytes > maximumBytes) {
        throw new RangeError('Response body exceeded the configured limit')
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
    if (totalBytes > maximumBytes) {
      await response.body?.cancel().catch(() => undefined)
    }
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function unavailableHealth(now: Date, latencyMs: number): ProviderHealth {
  return ProviderHealthSchema.parse({
    status: 'unavailable',
    configured: true,
    diagnosticCode: 'PROVIDER_UNAVAILABLE',
    capacity: 'unknown',
    checkedAt: now.toISOString(),
    latencyMs,
  })
}

function degradedHealth(
  now: Date,
  latencyMs: number,
  retryAfterMs: number | undefined,
): ProviderHealth {
  return ProviderHealthSchema.parse({
    status: 'degraded',
    configured: true,
    diagnosticCode: 'PROVIDER_DEGRADED',
    capacity: 'constrained',
    checkedAt: now.toISOString(),
    latencyMs,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  })
}

function validateProfile(profile: CloudflareBrowserRunProfile): CloudflareBrowserRunProfile {
  const capabilities = CapabilitySupportMapSchema.parse(profile.capabilities)
  if (
    profile.acceptedConnectionNamespaces.length === 0 ||
    profile.maximumKeepAliveMs < MIN_CLOUDFLARE_KEEP_ALIVE_MS ||
    profile.maximumKeepAliveMs > 10 * 60 * 1_000 ||
    (profile.maximumSessionDurationMs !== undefined &&
      profile.maximumSessionDurationMs < MIN_CLOUDFLARE_KEEP_ALIVE_MS) ||
    profile.browserSelector?.trim().length === 0
  ) {
    throw new ProviderError({
      code: 'PROVIDER_CONFIGURATION_ERROR',
      operation: 'descriptor',
      diagnosticCode: 'CLOUDFLARE_PROFILE_INVALID',
    })
  }
  return Object.freeze({ ...profile, capabilities })
}

export class CloudflareBrowserRunProvider implements BrowserProvider {
  readonly #profile: CloudflareBrowserRunProfile
  readonly #transport: CloudflareBrowserRunTransport
  readonly #descriptor: ProviderDescriptor
  readonly #now: () => Date
  readonly #monotonicNow: () => number
  readonly #connectionPathPrefix: string | undefined
  readonly #recentlyTerminatedSessionIDs = new Map<string, number>()
  readonly #terminationInFlight = new Map<string, Promise<ProviderTerminationResult>>()

  constructor(
    config: CloudflareConfig,
    profile: CloudflareBrowserRunProfile,
    options: CloudflareProviderOptions = {},
  ) {
    this.#profile = validateProfile(profile)
    this.#now = options.now ?? (() => new Date())
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.#transport = new CloudflareBrowserRunTransport(config, {
      apiNamespace: this.#profile.apiNamespace,
      fetch: options.fetch ?? fetch,
      nowEpochMs: () => this.#now().getTime(),
    })
    const basePath = config.apiBaseURL.pathname.replace(/\/+$/u, '')
    this.#connectionPathPrefix =
      config.credentials === undefined
        ? undefined
        : `${basePath}/accounts/${config.credentials.accountID}`
    this.#descriptor = ProviderDescriptorSchema.parse({
      providerID: 'cloudflare-browser-run',
      runtimeClass: this.#profile.runtimeClass,
      displayName: this.#profile.displayName,
      capabilities: this.#profile.capabilities,
      implementation: {
        name: this.#profile.implementationName,
        version: this.#profile.implementationVersion,
      },
      configProfile: this.#profile.configProfile,
      configured: this.#transport.configured,
    })
  }

  descriptor(): ProviderDescriptor {
    return this.#descriptor
  }

  async health(options: ProviderOperationOptions): Promise<ProviderHealth> {
    const validatedOptions = ProviderOperationOptionsSchema.parse(options)
    throwIfProviderOperationAborted(validatedOptions.signal, 'health')
    if (!this.#transport.configured) {
      return ProviderHealthSchema.parse({
        status: 'unavailable',
        configured: false,
        diagnosticCode: 'PROVIDER_NOT_CONFIGURED',
        capacity: 'unknown',
        checkedAt: this.#now().toISOString(),
      })
    }

    const startedAt = this.#monotonicNow()
    try {
      return await this.#transport.request(
        {
          operation: 'health',
          method: 'GET',
          path: ['session'],
          query: { limit: '1' },
        },
        validatedOptions,
        async (response) => {
          const latencyMs = Math.max(0, this.#monotonicNow() - startedAt)
          if (!response.ok) {
            throw await this.#transport.errorForResponse(response, 'health')
          }
          try {
            CloudflareHealthResponseSchema.parse(
              await parseBoundedJSON(response, MAX_HEALTH_RESPONSE_BYTES),
            )
          } catch (error: unknown) {
            if (error instanceof DOMException && error.name === 'AbortError') {
              throw error
            }
            return unavailableHealth(this.#now(), latencyMs)
          }
          return ProviderHealthSchema.parse({
            status: 'healthy',
            configured: true,
            diagnosticCode: 'PROVIDER_HEALTHY',
            capacity: 'unknown',
            checkedAt: this.#now().toISOString(),
            latencyMs,
          })
        },
      )
    } catch (error: unknown) {
      const normalized = normalizeProviderError(error, 'health')
      const latencyMs = Math.max(0, this.#monotonicNow() - startedAt)
      if (
        normalized.code === 'PROVIDER_RATE_LIMITED' ||
        normalized.code === 'PROVIDER_CAPACITY_EXHAUSTED'
      ) {
        return degradedHealth(this.#now(), latencyMs, normalized.retryAfterMs)
      }
      if (
        normalized.code === 'PROVIDER_AUTHORIZATION_ERROR' ||
        normalized.code === 'PROVIDER_TRANSIENT_UPSTREAM_FAILURE' ||
        normalized.code === 'PROVIDER_CONNECTION_FAILED' ||
        normalized.code === 'PROVIDER_INVALID_RESPONSE'
      ) {
        return unavailableHealth(this.#now(), latencyMs)
      }
      throw normalized
    }
  }

  async allocate(
    request: ProviderAllocateRequest,
    options: ProviderOperationOptions,
  ): Promise<ProviderSession> {
    const validatedOptions = ProviderOperationOptionsSchema.parse(options)
    throwIfProviderOperationAborted(validatedOptions.signal, 'allocate')
    let validatedRequest: ProviderAllocateRequest
    try {
      validatedRequest = ProviderAllocateRequestSchema.parse(request)
    } catch {
      throw new ProviderError({ code: 'PROVIDER_INVALID_RESPONSE', operation: 'allocate' })
    }
    if (!this.#transport.configured) {
      throw new ProviderError({
        code: 'PROVIDER_CONFIGURATION_ERROR',
        operation: 'allocate',
        diagnosticCode: 'CLOUDFLARE_NOT_CONFIGURED',
      })
    }
    this.#assertSupportedRequest(validatedRequest)
    const allocationDeadline = this.#monotonicNow() + validatedOptions.timeoutMs

    try {
      return await this.#transport.request(
        {
          operation: 'allocate',
          method: 'POST',
          path: ['browser'],
          query: this.#allocationQuery(validatedRequest.maxSessionDurationMs),
        },
        validatedOptions,
        async (response) => {
          if (!response.ok) {
            throw await this.#transport.errorForResponse(response, 'allocate')
          }
          let responseBody: unknown
          try {
            responseBody = await parseBoundedJSON(response, MAX_CREATE_RESPONSE_BYTES)
          } catch {
            throw new ProviderError({
              code: 'PROVIDER_INVALID_RESPONSE',
              operation: 'allocate',
              diagnosticCode: 'CLOUDFLARE_CREATE_RESPONSE_INVALID',
            })
          }

          const identity = CloudflareCreateSessionIdentitySchema.safeParse(responseBody)
          const parsedAllocation = CloudflareCreateSessionResponseSchema.safeParse(responseBody)
          if (!parsedAllocation.success) {
            if (identity.success) {
              await this.#cleanupInvalidAllocation(
                identity.data.sessionId,
                allocationDeadline,
                validatedOptions.signal,
              )
            }
            throw new ProviderError({
              code: 'PROVIDER_INVALID_RESPONSE',
              operation: 'allocate',
              diagnosticCode: 'CLOUDFLARE_CREATE_RESPONSE_INVALID',
            })
          }

          const allocation = parsedAllocation.data
          try {
            this.#validateConnectionURL(allocation.webSocketDebuggerUrl, allocation.sessionId)
          } catch {
            await this.#cleanupInvalidAllocation(
              allocation.sessionId,
              allocationDeadline,
              validatedOptions.signal,
            )
            throw new ProviderError({
              code: 'PROVIDER_INVALID_RESPONSE',
              operation: 'allocate',
              diagnosticCode: 'CLOUDFLARE_CREATE_RESPONSE_INVALID',
            })
          }

          const allocatedAt = this.#now()
          return ProviderSessionSchema.parse({
            reference: {
              providerID: this.#descriptor.providerID,
              runtimeClass: this.#descriptor.runtimeClass,
              providerSessionID: allocation.sessionId,
            },
            connection: {
              transport: 'websocket',
              endpoint: allocation.webSocketDebuggerUrl,
              credentialReference: `cloudflare-browser-run:${allocation.sessionId}`,
            },
            allocatedAt: allocatedAt.toISOString(),
            expiresAt: new Date(
              allocatedAt.getTime() + validatedRequest.maxSessionDurationMs,
            ).toISOString(),
            metadata: {
              configProfile: this.#descriptor.configProfile,
              implementationVersion: this.#descriptor.implementation.version,
            },
          })
        },
      )
    } catch (error: unknown) {
      throw normalizeProviderError(error, 'allocate')
    }
  }

  async terminate(
    reference: ProviderSessionRef,
    options: ProviderOperationOptions,
  ): Promise<ProviderTerminationResult> {
    const validatedOptions = ProviderOperationOptionsSchema.parse(options)
    throwIfProviderOperationAborted(validatedOptions.signal, 'terminate')
    let validatedReference: ProviderSessionRef
    try {
      validatedReference = ProviderSessionRefSchema.parse(reference)
    } catch {
      throw new ProviderError({ code: 'PROVIDER_INVALID_RESPONSE', operation: 'terminate' })
    }
    if (
      validatedReference.providerID !== this.#descriptor.providerID ||
      validatedReference.runtimeClass !== this.#descriptor.runtimeClass
    ) {
      throw new ProviderError({ code: 'PROVIDER_UNSUPPORTED', operation: 'terminate' })
    }
    if (!this.#transport.configured) {
      throw new ProviderError({
        code: 'PROVIDER_CONFIGURATION_ERROR',
        operation: 'terminate',
        diagnosticCode: 'CLOUDFLARE_NOT_CONFIGURED',
      })
    }
    if (this.#isRecentlyTerminated(validatedReference.providerSessionID)) {
      return this.#terminationResult('already_terminated', validatedReference)
    }

    const inFlight = this.#terminationInFlight.get(validatedReference.providerSessionID)
    if (inFlight !== undefined) {
      return this.#joinTermination(inFlight, validatedReference, validatedOptions)
    }

    return this.#startTermination(validatedReference, validatedOptions)
  }

  #allocationQuery(maxSessionDurationMs: number): Readonly<Record<string, string>> {
    const keepAliveMs = Math.max(
      MIN_CLOUDFLARE_KEEP_ALIVE_MS,
      Math.min(maxSessionDurationMs, this.#profile.maximumKeepAliveMs),
    )
    return {
      keep_alive: String(keepAliveMs),
      ...(this.#profile.browserSelector === undefined
        ? {}
        : { browser: this.#profile.browserSelector }),
    }
  }

  #startTermination(
    reference: ProviderSessionRef,
    options: ProviderOperationOptions,
  ): Promise<ProviderTerminationResult> {
    const operation = this.#terminateUpstream(reference, options)
    const tracked = operation.finally(() => {
      if (this.#terminationInFlight.get(reference.providerSessionID) === tracked) {
        this.#terminationInFlight.delete(reference.providerSessionID)
      }
    })
    this.#terminationInFlight.set(reference.providerSessionID, tracked)
    return tracked
  }

  async #terminateUpstream(
    validatedReference: ProviderSessionRef,
    validatedOptions: ProviderOperationOptions,
  ): Promise<ProviderTerminationResult> {
    try {
      return await this.#transport.request(
        {
          operation: 'terminate',
          method: 'DELETE',
          path: ['browser', validatedReference.providerSessionID],
        },
        validatedOptions,
        async (response) => {
          if (response.status === 404) {
            await response.body?.cancel().catch(() => undefined)
            this.#markRecentlyTerminated(validatedReference.providerSessionID)
            return this.#terminationResult('already_terminated', validatedReference)
          }
          if (!response.ok) {
            throw await this.#transport.errorForResponse(response, 'terminate')
          }
          try {
            CloudflareTerminationResponseSchema.parse(
              await parseBoundedJSON(response, MAX_TERMINATE_RESPONSE_BYTES),
            )
          } catch {
            throw new ProviderError({
              code: 'PROVIDER_INVALID_RESPONSE',
              operation: 'terminate',
              diagnosticCode: 'CLOUDFLARE_TERMINATE_RESPONSE_INVALID',
            })
          }
          this.#markRecentlyTerminated(validatedReference.providerSessionID)
          return this.#terminationResult('terminated', validatedReference)
        },
      )
    } catch (error: unknown) {
      throw normalizeProviderError(error, 'terminate', this.#terminationFallbackCode(error))
    }
  }

  async #cleanupInvalidAllocation(
    sessionID: string,
    allocationDeadline: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const remainingMs = Math.floor(allocationDeadline - this.#monotonicNow())
    if (remainingMs <= 0 || signal?.aborted === true) {
      return
    }
    const reference = ProviderSessionRefSchema.parse({
      providerID: this.#descriptor.providerID,
      runtimeClass: this.#descriptor.runtimeClass,
      providerSessionID: sessionID,
    })
    try {
      await this.terminate(reference, {
        timeoutMs: Math.min(remainingMs, MAX_ALLOCATION_CLEANUP_TIMEOUT_MS),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch {
      // Keep the original validation failure. Cleanup is one bounded best-effort request.
    }
  }

  #isRecentlyTerminated(sessionID: string): boolean {
    const expiry = this.#recentlyTerminatedSessionIDs.get(sessionID)
    if (expiry === undefined) {
      return false
    }
    if (expiry <= this.#monotonicNow()) {
      this.#recentlyTerminatedSessionIDs.delete(sessionID)
      return false
    }
    return true
  }

  #markRecentlyTerminated(sessionID: string): void {
    const monotonicNow = this.#monotonicNow()
    for (const [trackedSessionID, expiry] of this.#recentlyTerminatedSessionIDs) {
      if (expiry <= monotonicNow) {
        this.#recentlyTerminatedSessionIDs.delete(trackedSessionID)
      }
    }
    this.#recentlyTerminatedSessionIDs.delete(sessionID)
    while (this.#recentlyTerminatedSessionIDs.size >= MAX_RECENTLY_TERMINATED_SESSIONS) {
      const oldestSessionID = this.#recentlyTerminatedSessionIDs.keys().next().value
      if (oldestSessionID === undefined) {
        break
      }
      this.#recentlyTerminatedSessionIDs.delete(oldestSessionID)
    }
    this.#recentlyTerminatedSessionIDs.set(sessionID, monotonicNow + RECENT_TERMINATION_TTL_MS)
  }

  async #joinTermination(
    termination: Promise<ProviderTerminationResult>,
    reference: ProviderSessionRef,
    options: ProviderOperationOptions,
  ): Promise<ProviderTerminationResult> {
    const joinDeadline = this.#monotonicNow() + options.timeoutMs
    return new Promise<ProviderTerminationResult>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', onAbort)
        callback()
      }
      const onAbort = (): void => {
        finish(() => {
          reject(new ProviderError({ code: 'PROVIDER_OPERATION_ABORTED', operation: 'terminate' }))
        })
      }
      const timeout = setTimeout(() => {
        finish(() => {
          reject(new ProviderError({ code: 'PROVIDER_OPERATION_TIMEOUT', operation: 'terminate' }))
        })
      }, options.timeoutMs)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const settleFrom = (
        candidate: Promise<ProviderTerminationResult>,
        joinedExistingOperation: boolean,
      ): void => {
        candidate.then(
          (result) => {
            finish(() => {
              resolve(
                joinedExistingOperation
                  ? this.#terminationResult('already_terminated', reference)
                  : result,
              )
            })
          },
          (error: unknown) => {
            const normalized = normalizeProviderError(error, 'terminate')
            if (
              joinedExistingOperation &&
              !settled &&
              options.signal?.aborted !== true &&
              (normalized.code === 'PROVIDER_OPERATION_ABORTED' ||
                normalized.code === 'PROVIDER_OPERATION_TIMEOUT')
            ) {
              const remainingMs = Math.floor(joinDeadline - this.#monotonicNow())
              if (remainingMs <= 0) {
                finish(() => {
                  reject(
                    new ProviderError({
                      code: 'PROVIDER_OPERATION_TIMEOUT',
                      operation: 'terminate',
                    }),
                  )
                })
                return
              }
              settleFrom(
                this.terminate(reference, {
                  timeoutMs: remainingMs,
                  ...(options.signal === undefined ? {} : { signal: options.signal }),
                }),
                false,
              )
              return
            }
            finish(() => {
              reject(normalized)
            })
          },
        )
      }
      settleFrom(termination, true)
    })
  }

  #assertSupportedRequest(request: ProviderAllocateRequest): void {
    if (
      request.runtimeClass !== this.#descriptor.runtimeClass ||
      (this.#profile.maximumSessionDurationMs !== undefined &&
        request.maxSessionDurationMs > this.#profile.maximumSessionDurationMs)
    ) {
      throw new ProviderError({ code: 'PROVIDER_UNSUPPORTED', operation: 'allocate' })
    }
    for (const capability of CAPABILITY_NAMES) {
      const requirement = request.requirements[capability]
      if (
        requirement !== undefined &&
        !satisfiesCapabilityRequirement(
          this.#descriptor.capabilities[capability],
          requirement,
          request.allowExperimental,
        )
      ) {
        throw new ProviderError({ code: 'PROVIDER_UNSUPPORTED', operation: 'allocate' })
      }
    }
  }

  #validateConnectionURL(rawURL: string, sessionID: string): void {
    const url = new URL(rawURL)
    const prefix = this.#connectionPathPrefix
    const expectedPaths =
      prefix === undefined
        ? []
        : this.#profile.acceptedConnectionNamespaces.map(
            (namespace) => `${prefix}/${namespace}/devtools/browser/${sessionID}`,
          )
    if (
      url.protocol !== 'wss:' ||
      url.hostname !== 'api.cloudflare.com' ||
      url.port.length > 0 ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      !expectedPaths.includes(url.pathname)
    ) {
      throw new TypeError('Invalid Cloudflare websocket endpoint')
    }
  }

  #terminationResult(
    status: 'terminated' | 'already_terminated',
    reference: ProviderSessionRef,
  ): ProviderTerminationResult {
    return ProviderTerminationResultSchema.parse({
      status,
      reference,
      terminatedAt: this.#now().toISOString(),
    })
  }

  #terminationFallbackCode(error: unknown): ProviderErrorCode {
    return error instanceof ProviderError ? error.code : 'PROVIDER_UNKNOWN_ERROR'
  }
}
