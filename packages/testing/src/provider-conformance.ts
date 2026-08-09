import {
  ProviderDescriptorSchema,
  ProviderError,
  ProviderHealthSchema,
  ProviderSessionRefSchema,
  ProviderSessionSchema,
  ProviderTerminationResultSchema,
  type BrowserProvider,
  type ProviderAllocateRequest,
  type ProviderErrorCode,
} from '@surfgate/provider-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

export const PROVIDER_CONFORMANCE_SCENARIOS = [
  'default',
  'unconfigured',
  'degraded',
  'unavailable',
  'health_delayed',
  'health_timeout',
  'health_unknown_error',
  'health_secret_error',
  'allocation_delayed',
  'allocation_timeout',
  'allocation_configuration_error',
  'allocation_authorization_error',
  'allocation_rate_limited',
  'allocation_transient_error',
  'allocation_unsupported',
  'allocation_connection_error',
  'allocation_unknown_error',
  'allocation_secret_error',
  'termination_delayed',
  'termination_timeout',
  'termination_error',
  'termination_unknown_error',
  'termination_secret_error',
] as const

export type ProviderConformanceScenario = (typeof PROVIDER_CONFORMANCE_SCENARIOS)[number]

export type ProviderConformanceSuiteOptions = Readonly<{
  name: string
  createProvider: (
    scenario: ProviderConformanceScenario,
  ) => BrowserProvider | Promise<BrowserProvider>
  allocateRequest: () => ProviderAllocateRequest
}>

const DEFAULT_OPERATION_OPTIONS = Object.freeze({ timeoutMs: 100 })
const SHORT_OPERATION_TIMEOUT_MS = 25
const SENSITIVE_FIELD_PATTERN =
  /authorization|cookie|credential|headers?|password|secret|token|api[-_]?key/iu

function containsSensitiveField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveField(item))
  }
  if (value === null || typeof value !== 'object') {
    return false
  }

  return Object.entries(value).some(
    ([key, nestedValue]) =>
      SENSITIVE_FIELD_PATTERN.test(key) || containsSensitiveField(nestedValue),
  )
}

async function expectNormalizedProviderError(
  operation: Promise<unknown>,
  expectedCode: ProviderErrorCode,
): Promise<ProviderError> {
  try {
    await operation
    expect.fail(`Expected provider operation to fail with ${expectedCode}`)
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ProviderError)
    if (error instanceof ProviderError) {
      expect(error.code).toBe(expectedCode)
      expect(error.message).toMatch(/^The provider /u)
      return error
    }
  }

  throw new Error('Provider error assertion did not receive a ProviderError')
}

export function runProviderConformanceSuite(options: ProviderConformanceSuiteOptions): void {
  describe(`${options.name} provider conformance`, () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    describe('descriptor', () => {
      it('returns a valid stable provider-neutral descriptor', async () => {
        const provider = await options.createProvider('default')
        const first = provider.descriptor()
        const second = provider.descriptor()

        expect(ProviderDescriptorSchema.parse(first)).toEqual(first)
        expect(second.providerID).toBe(first.providerID)
        expect(second.runtimeClass).toBe(first.runtimeClass)
        expect(second.capabilities).toEqual(first.capabilities)
      })

      it('does not expose secret-shaped descriptor fields', async () => {
        const provider = await options.createProvider('default')

        expect(containsSensitiveField(provider.descriptor())).toBe(false)
      })
    })

    describe('health', () => {
      it.each([
        ['default', 'healthy', true],
        ['degraded', 'degraded', true],
        ['unavailable', 'unavailable', true],
        ['unconfigured', 'unavailable', false],
      ] as const)('returns normalized %s health', async (scenario, status, configured) => {
        const provider = await options.createProvider(scenario)
        const health = await provider.health(DEFAULT_OPERATION_OPTIONS)

        expect(ProviderHealthSchema.parse(health)).toEqual(health)
        expect(health.status).toBe(status)
        expect(health.configured).toBe(configured)
      })

      it('normalizes health failures instead of leaking arbitrary exceptions', async () => {
        const provider = await options.createProvider('health_unknown_error')

        await expectNormalizedProviderError(
          provider.health(DEFAULT_OPERATION_OPTIONS),
          'PROVIDER_UNKNOWN_ERROR',
        )
      })

      it('honors an AbortSignal already aborted before health', async () => {
        const provider = await options.createProvider('default')
        const controller = new AbortController()
        controller.abort()

        await expectNormalizedProviderError(
          provider.health({ timeoutMs: 100, signal: controller.signal }),
          'PROVIDER_OPERATION_ABORTED',
        )
      })

      it('honors cancellation during health', async () => {
        vi.useFakeTimers()
        const provider = await options.createProvider('health_delayed')
        const controller = new AbortController()
        const health = provider.health({ timeoutMs: 200, signal: controller.signal })
        const expectedError = expectNormalizedProviderError(health, 'PROVIDER_OPERATION_ABORTED')

        controller.abort()
        await expectedError
      })

      it('normalizes health timeout', async () => {
        vi.useFakeTimers()
        const provider = await options.createProvider('health_timeout')
        const health = provider.health({ timeoutMs: SHORT_OPERATION_TIMEOUT_MS })
        const expectedError = expectNormalizedProviderError(health, 'PROVIDER_OPERATION_TIMEOUT')

        await vi.advanceTimersByTimeAsync(SHORT_OPERATION_TIMEOUT_MS)
        await expectedError
      })

      it('sanitizes secret-bearing upstream health failures', async () => {
        const provider = await options.createProvider('health_secret_error')
        const error = await expectNormalizedProviderError(
          provider.health(DEFAULT_OPERATION_OPTIONS),
          'PROVIDER_UNKNOWN_ERROR',
        )
        const serialized = JSON.stringify(error)

        expect(serialized).not.toMatch(/Bearer|provider-secret|internal\.local|Authorization/u)
        expect(error.stack).not.toMatch(/Bearer|provider-secret|internal\.local|Authorization/u)
      })
    })

    describe('allocation', () => {
      it('returns a valid internal provider session with safe fixed metadata', async () => {
        const provider = await options.createProvider('default')
        const session = await provider.allocate(
          options.allocateRequest(),
          DEFAULT_OPERATION_OPTIONS,
        )

        expect(ProviderSessionSchema.parse(session)).toEqual(session)
        expect(session.reference.providerID).toBe(provider.descriptor().providerID)
        expect(session.reference.runtimeClass).toBe(provider.descriptor().runtimeClass)
        expect(containsSensitiveField(session.metadata)).toBe(false)
        expect(new URL(session.connection.endpoint).search).toBe('')
        expect(new URL(session.connection.endpoint).hash).toBe('')
      })

      it('honors an AbortSignal already aborted before allocation', async () => {
        const provider = await options.createProvider('default')
        const controller = new AbortController()
        controller.abort()

        await expectNormalizedProviderError(
          provider.allocate(options.allocateRequest(), {
            timeoutMs: 100,
            signal: controller.signal,
          }),
          'PROVIDER_OPERATION_ABORTED',
        )
      })

      it('honors cancellation during allocation', async () => {
        vi.useFakeTimers()
        const provider = await options.createProvider('allocation_delayed')
        const controller = new AbortController()
        const allocation = provider.allocate(options.allocateRequest(), {
          timeoutMs: 200,
          signal: controller.signal,
        })
        const expectedError = expectNormalizedProviderError(
          allocation,
          'PROVIDER_OPERATION_ABORTED',
        )

        controller.abort()
        await expectedError
      })

      it('normalizes allocation timeout', async () => {
        vi.useFakeTimers()
        const provider = await options.createProvider('allocation_timeout')
        const allocation = provider.allocate(options.allocateRequest(), {
          timeoutMs: SHORT_OPERATION_TIMEOUT_MS,
        })
        const expectedError = expectNormalizedProviderError(
          allocation,
          'PROVIDER_OPERATION_TIMEOUT',
        )

        await vi.advanceTimersByTimeAsync(SHORT_OPERATION_TIMEOUT_MS)
        await expectedError
      })

      it.each([
        ['allocation_configuration_error', 'PROVIDER_CONFIGURATION_ERROR'],
        ['allocation_authorization_error', 'PROVIDER_AUTHORIZATION_ERROR'],
        ['allocation_rate_limited', 'PROVIDER_RATE_LIMITED'],
        ['allocation_transient_error', 'PROVIDER_TRANSIENT_UPSTREAM_FAILURE'],
        ['allocation_unsupported', 'PROVIDER_UNSUPPORTED'],
        ['allocation_connection_error', 'PROVIDER_CONNECTION_FAILED'],
      ] as const)('normalizes the %s scenario', async (scenario, code) => {
        const provider = await options.createProvider(scenario)

        await expectNormalizedProviderError(
          provider.allocate(options.allocateRequest(), DEFAULT_OPERATION_OPTIONS),
          code,
        )
      })

      it('wraps unknown allocation exceptions', async () => {
        const provider = await options.createProvider('allocation_unknown_error')

        await expectNormalizedProviderError(
          provider.allocate(options.allocateRequest(), DEFAULT_OPERATION_OPTIONS),
          'PROVIDER_UNKNOWN_ERROR',
        )
      })

      it('sanitizes secret-bearing upstream allocation failures', async () => {
        const provider = await options.createProvider('allocation_secret_error')
        const error = await expectNormalizedProviderError(
          provider.allocate(options.allocateRequest(), DEFAULT_OPERATION_OPTIONS),
          'PROVIDER_UNKNOWN_ERROR',
        )
        const serialized = JSON.stringify(error)

        expect(serialized).not.toMatch(/Bearer|provider-secret|internal\.local|Authorization/u)
        expect(error.stack).not.toMatch(/Bearer|provider-secret|internal\.local|Authorization/u)
      })
    })

    describe('termination', () => {
      it('terminates successfully and is idempotent when called twice', async () => {
        const provider = await options.createProvider('default')
        const session = await provider.allocate(
          options.allocateRequest(),
          DEFAULT_OPERATION_OPTIONS,
        )

        const first = await provider.terminate(session.reference, DEFAULT_OPERATION_OPTIONS)
        const second = await provider.terminate(session.reference, DEFAULT_OPERATION_OPTIONS)

        expect(ProviderTerminationResultSchema.parse(first).status).toBe('terminated')
        expect(ProviderTerminationResultSchema.parse(second).status).toBe('already_terminated')
      })

      it('treats a nonexistent session as already terminated', async () => {
        const provider = await options.createProvider('default')
        const session = await provider.allocate(
          options.allocateRequest(),
          DEFAULT_OPERATION_OPTIONS,
        )
        const nonexistentReference = ProviderSessionRefSchema.parse({
          ...session.reference,
          providerSessionID: 'conformance-nonexistent-session',
        })

        await expect(
          provider.terminate(nonexistentReference, DEFAULT_OPERATION_OPTIONS),
        ).resolves.toMatchObject({ status: 'already_terminated' })
      })

      it('honors an AbortSignal already aborted before termination', async () => {
        const provider = await options.createProvider('default')
        const session = await provider.allocate(
          options.allocateRequest(),
          DEFAULT_OPERATION_OPTIONS,
        )
        const controller = new AbortController()
        controller.abort()

        await expectNormalizedProviderError(
          provider.terminate(session.reference, {
            timeoutMs: 100,
            signal: controller.signal,
          }),
          'PROVIDER_OPERATION_ABORTED',
        )
      })

      it('honors cancellation during termination', async () => {
        vi.useFakeTimers()
        const provider = await options.createProvider('termination_delayed')
        const session = await provider.allocate(
          options.allocateRequest(),
          DEFAULT_OPERATION_OPTIONS,
        )
        const controller = new AbortController()
        const termination = provider.terminate(session.reference, {
          timeoutMs: 200,
          signal: controller.signal,
        })
        const expectedError = expectNormalizedProviderError(
          termination,
          'PROVIDER_OPERATION_ABORTED',
        )

        controller.abort()
        await expectedError
      })

      it('normalizes termination timeout', async () => {
        vi.useFakeTimers()
        const provider = await options.createProvider('termination_timeout')
        const session = await provider.allocate(
          options.allocateRequest(),
          DEFAULT_OPERATION_OPTIONS,
        )
        const termination = provider.terminate(session.reference, {
          timeoutMs: SHORT_OPERATION_TIMEOUT_MS,
        })
        const expectedError = expectNormalizedProviderError(
          termination,
          'PROVIDER_OPERATION_TIMEOUT',
        )

        await vi.advanceTimersByTimeAsync(SHORT_OPERATION_TIMEOUT_MS)
        await expectedError
      })

      it('normalizes termination failures', async () => {
        const provider = await options.createProvider('termination_error')
        const session = await provider.allocate(
          options.allocateRequest(),
          DEFAULT_OPERATION_OPTIONS,
        )

        await expectNormalizedProviderError(
          provider.terminate(session.reference, DEFAULT_OPERATION_OPTIONS),
          'PROVIDER_TERMINATION_FAILED',
        )
      })

      it('wraps unknown termination exceptions', async () => {
        const provider = await options.createProvider('termination_unknown_error')
        const session = await provider.allocate(
          options.allocateRequest(),
          DEFAULT_OPERATION_OPTIONS,
        )

        await expectNormalizedProviderError(
          provider.terminate(session.reference, DEFAULT_OPERATION_OPTIONS),
          'PROVIDER_UNKNOWN_ERROR',
        )
      })

      it('sanitizes secret-bearing upstream termination failures', async () => {
        const provider = await options.createProvider('termination_secret_error')
        const session = await provider.allocate(
          options.allocateRequest(),
          DEFAULT_OPERATION_OPTIONS,
        )
        const error = await expectNormalizedProviderError(
          provider.terminate(session.reference, DEFAULT_OPERATION_OPTIONS),
          'PROVIDER_UNKNOWN_ERROR',
        )
        const serialized = JSON.stringify(error)

        expect(serialized).not.toMatch(/Bearer|provider-secret|internal\.local|Authorization/u)
        expect(error.stack).not.toMatch(/Bearer|provider-secret|internal\.local|Authorization/u)
      })
    })
  })
}
