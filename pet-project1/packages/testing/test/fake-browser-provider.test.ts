import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FakeBrowserProvider,
  createFakeAllocateRequest,
  createFakeProviderConfig,
  createFakeProviderDescriptor,
} from '../src/index.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('FakeBrowserProvider descriptor and health', () => {
  it('returns a stable validated descriptor', () => {
    const provider = new FakeBrowserProvider(createFakeProviderConfig())

    expect(provider.descriptor()).toBe(provider.descriptor())
    expect(provider.descriptor()).toMatchObject({
      providerID: 'fake-provider',
      runtimeClass: 'test-browser',
      configured: true,
    })
  })

  it('rejects an invalid descriptor at construction', () => {
    try {
      new FakeBrowserProvider(
        createFakeProviderConfig({
          descriptor: {
            providerID: 'Invalid Provider ID',
            runtimeClass: 'test-browser',
          },
        }),
      )
      expect.fail('Expected an invalid descriptor to throw')
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' })
    }
  })

  it('rejects an invalid capability declaration at construction', () => {
    const descriptor = createFakeProviderDescriptor()

    try {
      new FakeBrowserProvider(
        createFakeProviderConfig({
          descriptor: {
            ...descriptor,
            capabilities: { ...descriptor.capabilities, webgl: 'partial' },
          },
        }),
      )
      expect.fail('Expected invalid capabilities to throw')
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' })
    }
  })

  it.each([
    ['healthy', 'healthy', 'PROVIDER_HEALTHY'],
    ['degraded', 'degraded', 'PROVIDER_DEGRADED'],
    ['unavailable', 'unavailable', 'PROVIDER_UNAVAILABLE'],
  ] as const)('returns normalized %s health', async (behavior, status, diagnosticCode) => {
    const provider = new FakeBrowserProvider(createFakeProviderConfig({ health: { behavior } }))

    await expect(provider.health({ timeoutMs: 100 })).resolves.toMatchObject({
      status,
      configured: true,
      diagnosticCode,
    })
  })

  it('distinguishes a provider that is not configured', async () => {
    const descriptor = createFakeProviderDescriptor()
    const provider = new FakeBrowserProvider(
      createFakeProviderConfig({
        descriptor: { ...descriptor, configured: false },
      }),
    )

    await expect(provider.health({ timeoutMs: 100 })).resolves.toMatchObject({
      status: 'unavailable',
      configured: false,
      diagnosticCode: 'PROVIDER_NOT_CONFIGURED',
    })
  })
})

describe('FakeBrowserProvider allocation', () => {
  it('allocates deterministic valid provider sessions', async () => {
    const provider = new FakeBrowserProvider(createFakeProviderConfig())
    const request = createFakeAllocateRequest()

    const first = await provider.allocate(request, { timeoutMs: 100 })
    const second = await provider.allocate(request, { timeoutMs: 100 })

    expect(first.reference.providerSessionID).toBe('fake-session-000001')
    expect(second.reference.providerSessionID).toBe('fake-session-000002')
    expect(first.allocatedAt).toBe('2026-08-08T00:00:00.000Z')
    expect(first.connection).toEqual({
      transport: 'websocket',
      endpoint: 'wss://browser.example.test/session/fake-session-000001',
      credentialReference: 'fake-credential-ref-000001',
    })
  })

  it('honors a configured allocation delay with fake timers', async () => {
    vi.useFakeTimers()
    const provider = new FakeBrowserProvider(
      createFakeProviderConfig({ allocation: { behavior: 'success', delayMs: 50 } }),
    )
    let settled = false

    const allocation = provider
      .allocate(createFakeAllocateRequest(), { timeoutMs: 100 })
      .finally(() => {
        settled = true
      })

    await vi.advanceTimersByTimeAsync(49)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(allocation).resolves.toBeDefined()
  })

  it('rejects an AbortSignal already aborted before allocation', async () => {
    const provider = new FakeBrowserProvider(createFakeProviderConfig())
    const controller = new AbortController()
    controller.abort()

    await expect(
      provider.allocate(createFakeAllocateRequest(), {
        timeoutMs: 100,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_ABORTED' })
  })

  it('rejects when the signal aborts during allocation', async () => {
    vi.useFakeTimers()
    const provider = new FakeBrowserProvider(
      createFakeProviderConfig({ allocation: { behavior: 'success', delayMs: 100 } }),
    )
    const controller = new AbortController()

    const allocation = provider.allocate(createFakeAllocateRequest(), {
      timeoutMs: 200,
      signal: controller.signal,
    })
    await vi.advanceTimersByTimeAsync(25)
    controller.abort()

    await expect(allocation).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_ABORTED' })
  })

  it('normalizes an allocation timeout', async () => {
    vi.useFakeTimers()
    const provider = new FakeBrowserProvider(
      createFakeProviderConfig({ allocation: { behavior: 'timeout' } }),
    )

    const allocation = provider.allocate(createFakeAllocateRequest(), { timeoutMs: 25 })
    const expectedRejection = expect(allocation).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(25)

    await expectedRejection
  })

  it.each([
    ['configuration_error', 'PROVIDER_CONFIGURATION_ERROR'],
    ['authorization_error', 'PROVIDER_AUTHORIZATION_ERROR'],
    ['rate_limited', 'PROVIDER_RATE_LIMITED'],
    ['capacity_exhausted', 'PROVIDER_CAPACITY_EXHAUSTED'],
    ['transient_failure', 'PROVIDER_TRANSIENT_UPSTREAM_FAILURE'],
    ['unsupported', 'PROVIDER_UNSUPPORTED'],
    ['connection_failure', 'PROVIDER_CONNECTION_FAILED'],
    ['invalid_response', 'PROVIDER_INVALID_RESPONSE'],
  ] as const)('maps %s allocation behavior to %s', async (behavior, code) => {
    const provider = new FakeBrowserProvider(createFakeProviderConfig({ allocation: { behavior } }))

    await expect(
      provider.allocate(createFakeAllocateRequest(), { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code })
  })

  it('normalizes an unknown thrown value and removes secret context', async () => {
    const secret = 'Bearer provider-secret-at-internal.provider.local'
    const provider = new FakeBrowserProvider(
      createFakeProviderConfig({
        allocation: { behavior: 'throw_unknown', thrownValue: new Error(secret) },
      }),
    )

    try {
      await provider.allocate(createFakeAllocateRequest(), { timeoutMs: 100 })
      expect.fail('Expected allocation failure')
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'PROVIDER_UNKNOWN_ERROR' })
      expect(JSON.stringify(error)).not.toContain(secret)
      expect(error instanceof Error ? error.stack : '').not.toContain(secret)
    }
  })
})

describe('FakeBrowserProvider termination', () => {
  it('terminates successfully and treats repeated termination as idempotent', async () => {
    const provider = new FakeBrowserProvider(createFakeProviderConfig())
    const session = await provider.allocate(createFakeAllocateRequest(), { timeoutMs: 100 })

    await expect(provider.terminate(session.reference, { timeoutMs: 100 })).resolves.toMatchObject({
      status: 'terminated',
    })
    await expect(provider.terminate(session.reference, { timeoutMs: 100 })).resolves.toMatchObject({
      status: 'already_terminated',
    })
  })

  it('treats a nonexistent session as already terminated', async () => {
    const provider = new FakeBrowserProvider(createFakeProviderConfig())
    const session = await provider.allocate(createFakeAllocateRequest(), { timeoutMs: 100 })

    await expect(
      provider.terminate(
        { ...session.reference, providerSessionID: 'fake-session-nonexistent' },
        { timeoutMs: 100 },
      ),
    ).resolves.toMatchObject({ status: 'already_terminated' })
  })

  it('normalizes termination failure', async () => {
    const provider = new FakeBrowserProvider(
      createFakeProviderConfig({ termination: { behavior: 'failure' } }),
    )
    const session = await provider.allocate(createFakeAllocateRequest(), { timeoutMs: 100 })

    await expect(provider.terminate(session.reference, { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'PROVIDER_TERMINATION_FAILED',
    })
  })
})
