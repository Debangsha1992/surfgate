import { describe, expect, it } from 'vitest'

import {
  PROVIDER_ERROR_CODES,
  ProviderAllocateRequestSchema,
  ProviderDescriptorSchema,
  ProviderError,
  ProviderErrorCodeSchema,
  ProviderHealthSchema,
  ProviderOperationOptionsSchema,
  ProviderSessionSchema,
  ProviderTerminationResultSchema,
  normalizeProviderError,
  throwIfProviderOperationAborted,
} from '../src/index.js'

const COMPLETE_CAPABILITIES = {
  javascript: 'supported',
  dom: 'supported',
  xhr: 'supported',
  svg: 'supported',
  screenshot: 'supported',
  pdf: 'experimental',
  webgl: 'unsupported',
  video: 'unsupported',
  persistentAuth: 'experimental',
  realBrowserTLS: 'unknown',
  downloads: 'supported',
  uploads: 'supported',
  multiTab: 'supported',
  longSession: 'unknown',
} as const

const VALID_DESCRIPTOR = {
  providerID: 'fake-provider',
  runtimeClass: 'test-browser',
  displayName: 'Deterministic Fake Browser',
  capabilities: COMPLETE_CAPABILITIES,
  implementation: {
    name: '@surfgate/testing/fake-browser-provider',
    version: '1.0.0',
  },
  region: 'local',
  configProfile: 'conformance',
  configured: true,
} as const

const VALID_REQUEST = {
  requestID: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  runtimeClass: 'test-browser',
  requirements: {
    javascript: 'required',
    screenshot: 'preferred',
  },
  allowExperimental: false,
  maxSessionDurationMs: 60_000,
  targetURL: 'https://example.test/',
  region: 'local',
  configProfile: 'conformance',
  metadata: {
    traceID: '4bf92f3577b34da6a3ce929d0e0e4736',
    operationName: 'provider.allocate',
  },
} as const

const VALID_SESSION = {
  reference: {
    providerID: 'fake-provider',
    runtimeClass: 'test-browser',
    providerSessionID: 'fake-session-000001',
  },
  connection: {
    transport: 'websocket',
    endpoint: 'wss://browser.example.test/session/fake-session-000001',
    credentialReference: 'credential-ref-000001',
  },
  allocatedAt: '2026-08-08T00:00:00.000Z',
  expiresAt: '2026-08-08T00:01:00.000Z',
  metadata: {
    region: 'local',
    configProfile: 'conformance',
    implementationVersion: '1.0.0',
  },
} as const

describe('provider descriptor contract', () => {
  it('validates a provider-neutral descriptor with exhaustive capabilities', () => {
    expect(ProviderDescriptorSchema.parse(VALID_DESCRIPTOR)).toEqual(VALID_DESCRIPTOR)
  })

  it('rejects an invalid provider descriptor', () => {
    expect(
      ProviderDescriptorSchema.safeParse({ ...VALID_DESCRIPTOR, providerID: 'Not Valid' }).success,
    ).toBe(false)
  })

  it('rejects an incomplete or invalid capability declaration', () => {
    const { webgl: _webgl, ...incompleteCapabilities } = COMPLETE_CAPABILITIES

    expect(
      ProviderDescriptorSchema.safeParse({
        ...VALID_DESCRIPTOR,
        capabilities: incompleteCapabilities,
      }).success,
    ).toBe(false)
    expect(
      ProviderDescriptorSchema.safeParse({
        ...VALID_DESCRIPTOR,
        capabilities: { ...COMPLETE_CAPABILITIES, webgl: 'partial' },
      }).success,
    ).toBe(false)
    expect(_webgl).toBe('unsupported')
  })

  it('rejects secret-shaped descriptor fields', () => {
    expect(
      ProviderDescriptorSchema.safeParse({
        ...VALID_DESCRIPTOR,
        authorizationHeader: 'Bearer provider-secret',
      }).success,
    ).toBe(false)
  })
})

describe('provider health contract', () => {
  it.each([
    {
      status: 'healthy',
      configured: true,
      diagnosticCode: 'PROVIDER_HEALTHY',
      capacity: 'available',
    },
    {
      status: 'degraded',
      configured: true,
      diagnosticCode: 'PROVIDER_DEGRADED',
      capacity: 'constrained',
    },
    {
      status: 'unavailable',
      configured: true,
      diagnosticCode: 'PROVIDER_UNAVAILABLE',
      capacity: 'unknown',
    },
    {
      status: 'unavailable',
      configured: false,
      diagnosticCode: 'PROVIDER_NOT_CONFIGURED',
      capacity: 'unknown',
    },
  ] as const)('validates normalized $diagnosticCode health', (health) => {
    expect(
      ProviderHealthSchema.parse({
        ...health,
        checkedAt: '2026-08-08T00:00:00.000Z',
        latencyMs: 12,
      }),
    ).toMatchObject(health)
  })

  it('rejects contradictory unconfigured health', () => {
    expect(
      ProviderHealthSchema.safeParse({
        status: 'healthy',
        configured: false,
        diagnosticCode: 'PROVIDER_NOT_CONFIGURED',
        capacity: 'available',
        checkedAt: '2026-08-08T00:00:00.000Z',
      }).success,
    ).toBe(false)
  })
})

describe('provider lifecycle contracts', () => {
  it('validates a bounded provider allocation request', () => {
    expect(ProviderAllocateRequestSchema.parse(VALID_REQUEST)).toEqual(VALID_REQUEST)
  })

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.test/file'])(
    'rejects unsupported target URL %s',
    (targetURL) => {
      expect(ProviderAllocateRequestSchema.safeParse({ ...VALID_REQUEST, targetURL }).success).toBe(
        false,
      )
    },
  )

  it('validates an internal provider session without raw credential fields', () => {
    expect(ProviderSessionSchema.parse(VALID_SESSION)).toEqual(VALID_SESSION)
    expect(
      ProviderSessionSchema.safeParse({
        ...VALID_SESSION,
        connection: {
          ...VALID_SESSION.connection,
          headers: { authorization: 'Bearer provider-secret' },
        },
      }).success,
    ).toBe(false)
    expect(
      ProviderSessionSchema.safeParse({
        ...VALID_SESSION,
        connection: {
          ...VALID_SESSION.connection,
          endpoint: 'wss://browser.example.test/session?id=secret#credential',
        },
      }).success,
    ).toBe(false)
  })

  it('returns validation failure instead of throwing for malformed websocket endpoints', () => {
    expect(
      ProviderSessionSchema.safeParse({
        ...VALID_SESSION,
        connection: { ...VALID_SESSION.connection, endpoint: 'not a URL' },
      }).success,
    ).toBe(false)
  })

  it.each(['terminated', 'already_terminated'] as const)(
    'validates the %s termination result',
    (status) => {
      expect(
        ProviderTerminationResultSchema.parse({
          status,
          reference: VALID_SESSION.reference,
          terminatedAt: '2026-08-08T00:00:01.000Z',
        }),
      ).toMatchObject({ status })
    },
  )

  it('requires a finite positive operation timeout', () => {
    expect(ProviderOperationOptionsSchema.safeParse({ timeoutMs: 1_000 }).success).toBe(true)
    expect(ProviderOperationOptionsSchema.safeParse({ timeoutMs: 0 }).success).toBe(false)
    expect(ProviderOperationOptionsSchema.safeParse({ timeoutMs: Infinity }).success).toBe(false)
    expect(ProviderOperationOptionsSchema.safeParse({}).success).toBe(false)
  })
})

describe('normalized provider errors', () => {
  it('defines every required stable provider error category', () => {
    expect(PROVIDER_ERROR_CODES).toEqual([
      'PROVIDER_CONFIGURATION_ERROR',
      'PROVIDER_AUTHORIZATION_ERROR',
      'PROVIDER_OPERATION_ABORTED',
      'PROVIDER_OPERATION_TIMEOUT',
      'PROVIDER_RATE_LIMITED',
      'PROVIDER_CAPACITY_EXHAUSTED',
      'PROVIDER_TRANSIENT_UPSTREAM_FAILURE',
      'PROVIDER_UNSUPPORTED',
      'PROVIDER_CONNECTION_FAILED',
      'PROVIDER_INVALID_RESPONSE',
      'PROVIDER_TERMINATION_FAILED',
      'PROVIDER_UNKNOWN_ERROR',
    ])
    expect(ProviderErrorCodeSchema.safeParse('raw-upstream-message').success).toBe(false)
  })

  it('classifies rate limits and timeouts as retryable with canonical messages', () => {
    const rateLimit = new ProviderError({
      code: 'PROVIDER_RATE_LIMITED',
      operation: 'allocate',
      retryAfterMs: 1_000,
      diagnosticCode: 'UPSTREAM_RATE_LIMIT',
    })
    const timeout = new ProviderError({
      code: 'PROVIDER_OPERATION_TIMEOUT',
      operation: 'allocate',
    })

    expect(rateLimit.retryable).toBe(true)
    expect(rateLimit.retryAfterMs).toBe(1_000)
    expect(timeout.retryable).toBe(true)
    expect(rateLimit.message).toBe('The provider rate limit was reached.')
  })

  it('normalizes unknown thrown values without leaking secret-bearing context', () => {
    const secret = 'Bearer provider-secret-at-internal.provider.local'
    const normalized = normalizeProviderError(new Error(secret), 'allocate')
    const thrownValue = normalizeProviderError({ authorization: secret }, 'health')

    expect(normalized).toBeInstanceOf(ProviderError)
    expect(normalized.code).toBe('PROVIDER_UNKNOWN_ERROR')
    expect(thrownValue.code).toBe('PROVIDER_UNKNOWN_ERROR')
    expect(JSON.stringify(normalized)).not.toContain(secret)
    expect(JSON.stringify(thrownValue)).not.toContain(secret)
    expect(normalized.stack).not.toContain(secret)
  })

  it('drops invalid diagnostic identifiers without exposing their input', () => {
    const secret = 'Bearer provider-secret-at-internal.provider.local'
    const error = new ProviderError({
      code: 'PROVIDER_TRANSIENT_UPSTREAM_FAILURE',
      operation: 'allocate',
      diagnosticCode: secret,
    })

    expect(error.diagnosticCode).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it('preserves an existing normalized provider error', () => {
    const original = new ProviderError({
      code: 'PROVIDER_CONNECTION_FAILED',
      operation: 'allocate',
    })

    expect(normalizeProviderError(original, 'allocate')).toBe(original)
  })

  it('normalizes an already-aborted operation', () => {
    const controller = new AbortController()
    controller.abort()

    try {
      throwIfProviderOperationAborted(controller.signal, 'allocate')
      expect.fail('Expected an aborted provider operation to throw')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ProviderError)
      if (error instanceof ProviderError) {
        expect(error.code).toBe('PROVIDER_OPERATION_ABORTED')
      }
    }
  })
})

export { COMPLETE_CAPABILITIES, VALID_DESCRIPTOR, VALID_REQUEST, VALID_SESSION }
