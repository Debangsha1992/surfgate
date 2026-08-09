import {
  ProviderDescriptorSchema,
  ProviderSessionRefSchema,
  ProviderSessionSchema,
} from '@surfgate/provider-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { KITESURF_CAPABILITIES, createKitesurfBrowserProvider } from '../src/index.js'
import type { KitesurfBrowserProvider } from '../src/index.js'
import {
  CONFIGURED_CLOUDFLARE_CONFIG,
  TEST_API_TOKEN,
  TEST_NOW,
  TEST_SESSION_ID,
  UNCONFIGURED_CLOUDFLARE_CONFIG,
  VALID_CREATE_RESPONSE,
  createKitesurfAllocateRequest,
} from './fixtures.js'
import { createScriptedFetch } from './test-transport.js'

afterEach(() => {
  vi.useRealTimers()
})

function createProvider(
  steps: Parameters<typeof createScriptedFetch>[0],
  options: Readonly<{ monotonicNow?: () => number }> = {},
): Readonly<{
  provider: KitesurfBrowserProvider
  calls: ReturnType<typeof createScriptedFetch>['calls']
}> {
  const transport = createScriptedFetch(steps, TEST_API_TOKEN)
  const provider = createKitesurfBrowserProvider(CONFIGURED_CLOUDFLARE_CONFIG, {
    fetch: transport.fetch,
    now: () => TEST_NOW,
    monotonicNow: options.monotonicNow ?? (() => 10),
  })
  return { provider, calls: transport.calls }
}

describe('Kitesurf descriptor and health', () => {
  it('reports not configured without making a network call', async () => {
    const transport = createScriptedFetch([], TEST_API_TOKEN)
    const provider = createKitesurfBrowserProvider(UNCONFIGURED_CLOUDFLARE_CONFIG, {
      fetch: transport.fetch,
      now: () => TEST_NOW,
      monotonicNow: () => 10,
    })

    expect(provider.descriptor().configured).toBe(false)
    await expect(provider.health({ timeoutMs: 100 })).resolves.toMatchObject({
      status: 'unavailable',
      configured: false,
      diagnosticCode: 'PROVIDER_NOT_CONFIGURED',
    })
    expect(transport.calls).toHaveLength(0)
  })

  it('returns a stable validated provider-neutral descriptor', () => {
    const { provider } = createProvider([])

    expect(ProviderDescriptorSchema.parse(provider.descriptor())).toEqual(provider.descriptor())
    expect(provider.descriptor()).toBe(provider.descriptor())
    expect(provider.descriptor()).toMatchObject({
      providerID: 'cloudflare-browser-run',
      runtimeClass: 'kitesurf',
      configured: true,
    })
  })

  it('rejects an unsafe Cloudflare API base URL before any request', () => {
    expect(() =>
      createKitesurfBrowserProvider(
        {
          ...CONFIGURED_CLOUDFLARE_CONFIG,
          apiBaseURL: new URL('https://api.cloudflare.com:444/client/v4'),
        },
        { fetch },
      ),
    ).toThrowError('The provider is not configured correctly.')
  })

  it('declares current beta capabilities conservatively', () => {
    expect(KITESURF_CAPABILITIES).toEqual({
      javascript: 'experimental',
      dom: 'experimental',
      xhr: 'experimental',
      svg: 'experimental',
      screenshot: 'experimental',
      pdf: 'experimental',
      webgl: 'unsupported',
      video: 'unsupported',
      persistentAuth: 'unsupported',
      realBrowserTLS: 'unsupported',
      downloads: 'unknown',
      uploads: 'unknown',
      multiTab: 'unsupported',
      longSession: 'unsupported',
    })
  })

  it('uses the lightweight session-list endpoint for healthy state', async () => {
    const { provider, calls } = createProvider([{ kind: 'response', body: [] }])

    await expect(provider.health({ timeoutMs: 100 })).resolves.toMatchObject({
      status: 'healthy',
      configured: true,
      capacity: 'unknown',
    })
    expect(new URL(calls[0]?.url ?? '').pathname).toContain('/browser-run/devtools/session')
  })

  it('maps a health rate limit to degraded capacity', async () => {
    const { provider } = createProvider([
      { kind: 'response', status: 429, body: { errors: [] }, headers: { 'retry-after': '2' } },
    ])

    await expect(provider.health({ timeoutMs: 100 })).resolves.toMatchObject({
      status: 'degraded',
      configured: true,
      capacity: 'constrained',
      retryAfterMs: 2_000,
    })
  })

  it('maps a health upstream failure to unavailable', async () => {
    const { provider } = createProvider([
      { kind: 'response', status: 503, body: { errors: [{ message: 'unavailable' }] } },
    ])

    await expect(provider.health({ timeoutMs: 100 })).resolves.toMatchObject({
      status: 'unavailable',
      configured: true,
      diagnosticCode: 'PROVIDER_UNAVAILABLE',
    })
  })

  it('keeps the health timeout active while consuming the response body', async () => {
    vi.useFakeTimers()
    const { provider } = createProvider([{ kind: 'delayed_body', body: [], delayMs: 100 }])
    const health = provider.health({ timeoutMs: 25 })
    const rejection = expect(health).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_TIMEOUT',
    })

    await vi.advanceTimersByTimeAsync(25)

    await rejection
  })
})

describe('Kitesurf allocation', () => {
  it('allocates a validated session with Kitesurf selected and credentials kept in headers', async () => {
    const { provider, calls } = createProvider([{ kind: 'response', body: VALID_CREATE_RESPONSE }])

    const session = await provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 100 })

    expect(ProviderSessionSchema.parse(session)).toEqual(session)
    expect(session.reference).toMatchObject({
      providerID: 'cloudflare-browser-run',
      runtimeClass: 'kitesurf',
      providerSessionID: TEST_SESSION_ID,
    })
    const allocationURL = new URL(calls[0]?.url ?? '')
    expect(allocationURL.searchParams.get('browser')).toBe('kitesurf')
    expect(allocationURL.searchParams.get('keep_alive')).toBe('60000')
    expect(calls[0]).toMatchObject({
      method: 'POST',
      authorizationIsExpected: true,
      headerNames: ['authorization'],
    })
    expect(JSON.stringify(calls)).not.toContain(TEST_API_TOKEN)
    expect(new URL(session.connection.endpoint).search).toBe('')
  })

  it('accepts the clean legacy-namespace WSS URL currently returned by Browser Run', async () => {
    const legacyURL = VALID_CREATE_RESPONSE.webSocketDebuggerUrl.replace(
      '/browser-run/',
      '/browser-rendering/',
    )
    const { provider } = createProvider([
      {
        kind: 'response',
        body: { ...VALID_CREATE_RESPONSE, webSocketDebuggerUrl: legacyURL },
      },
    ])

    await expect(
      provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 100 }),
    ).resolves.toMatchObject({ connection: { endpoint: legacyURL } })
  })

  it.each([
    { sessionId: TEST_SESSION_ID },
    { ...VALID_CREATE_RESPONSE, webSocketDebuggerUrl: 'wss://attacker.example/session' },
    {
      ...VALID_CREATE_RESPONSE,
      webSocketDebuggerUrl: `${VALID_CREATE_RESPONSE.webSocketDebuggerUrl}?token=secret`,
    },
    {
      ...VALID_CREATE_RESPONSE,
      webSocketDebuggerUrl: VALID_CREATE_RESPONSE.webSocketDebuggerUrl.replace(
        'api.cloudflare.com',
        'api.cloudflare.com:444',
      ),
    },
  ] as const)('rejects an invalid allocation response: %s', async (body) => {
    const { provider } = createProvider([{ kind: 'response', body }])

    await expect(
      provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' })
  })

  it('best-effort terminates a partially valid allocation with an unsafe endpoint', async () => {
    const { provider, calls } = createProvider([
      {
        kind: 'response',
        body: { ...VALID_CREATE_RESPONSE, webSocketDebuggerUrl: 'wss://attacker.example/session' },
      },
      { kind: 'response', body: { status: 'closing' } },
    ])

    await expect(
      provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' })
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1)
  })

  it('keeps partial-allocation cleanup inside the original timeout budget', async () => {
    vi.useFakeTimers()
    let notifyCleanupStarted: (() => void) | undefined
    const cleanupStarted = new Promise<void>((resolve) => {
      notifyCleanupStarted = resolve
    })
    const { provider } = createProvider(
      [
        {
          kind: 'response',
          body: {
            ...VALID_CREATE_RESPONSE,
            webSocketDebuggerUrl: 'wss://attacker.example/session',
          },
        },
        { kind: 'pending', onRequest: () => notifyCleanupStarted?.() },
      ],
      { monotonicNow: () => Date.now() },
    )
    const allocation = provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 25 })
    const rejection = expect(allocation).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_TIMEOUT',
    })

    await cleanupStarted
    await vi.advanceTimersByTimeAsync(25)

    await rejection
  })

  it('honors caller cancellation during partial-allocation cleanup', async () => {
    let notifyCleanupStarted: (() => void) | undefined
    const cleanupStarted = new Promise<void>((resolve) => {
      notifyCleanupStarted = resolve
    })
    const { provider } = createProvider([
      {
        kind: 'response',
        body: {
          ...VALID_CREATE_RESPONSE,
          webSocketDebuggerUrl: 'wss://attacker.example/session',
        },
      },
      { kind: 'pending', onRequest: () => notifyCleanupStarted?.() },
    ])
    const controller = new AbortController()
    const allocation = provider.allocate(createKitesurfAllocateRequest(), {
      timeoutMs: 200,
      signal: controller.signal,
    })

    await cleanupStarted
    controller.abort()

    await expect(allocation).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_ABORTED' })
  })

  it('requires an explicit experimental-capability opt-in', async () => {
    const { provider, calls } = createProvider([])

    await expect(
      provider.allocate(createKitesurfAllocateRequest({ allowExperimental: false }), {
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' })
    expect(calls).toHaveLength(0)
  })

  it('rejects an AbortSignal already aborted before allocation without fetching', async () => {
    const { provider, calls } = createProvider([{ kind: 'response', body: VALID_CREATE_RESPONSE }])
    const controller = new AbortController()
    controller.abort()

    await expect(
      provider.allocate(createKitesurfAllocateRequest(), {
        timeoutMs: 100,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_ABORTED' })
    expect(calls).toHaveLength(0)
  })

  it('honors cancellation during allocation', async () => {
    const { provider } = createProvider([{ kind: 'pending' }])
    const controller = new AbortController()
    const allocation = provider.allocate(createKitesurfAllocateRequest(), {
      timeoutMs: 200,
      signal: controller.signal,
    })

    controller.abort()

    await expect(allocation).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_ABORTED' })
  })

  it('normalizes allocation timeout', async () => {
    vi.useFakeTimers()
    const { provider } = createProvider([{ kind: 'pending' }])
    const allocation = provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 25 })
    const rejection = expect(allocation).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_TIMEOUT',
    })

    await vi.advanceTimersByTimeAsync(25)

    await rejection
  })

  it('keeps the allocation timeout active while consuming the response body', async () => {
    vi.useFakeTimers()
    const { provider } = createProvider([
      { kind: 'delayed_body', body: VALID_CREATE_RESPONSE, delayMs: 100 },
    ])
    const allocation = provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 25 })
    const rejection = expect(allocation).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_TIMEOUT',
    })

    await vi.advanceTimersByTimeAsync(25)

    await rejection
  })

  it.each([401, 403])('normalizes HTTP %s as authorization failure', async (status) => {
    const { provider } = createProvider([
      { kind: 'response', status, body: { errors: [{ message: 'denied' }] } },
    ])

    await expect(
      provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTHORIZATION_ERROR' })
  })

  it('normalizes rate limiting and retry delay', async () => {
    const { provider } = createProvider([
      { kind: 'response', status: 429, body: { errors: [] }, headers: { 'retry-after': '3' } },
    ])

    await expect(
      provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryAfterMs: 3_000 })
  })

  it("normalizes Cloudflare's documented daily browser quota as exhausted capacity", async () => {
    const { provider } = createProvider([
      {
        kind: 'response',
        status: 429,
        body: { errors: [{ message: 'Browser time limit exceeded for today' }] },
      },
    ])

    await expect(
      provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CAPACITY_EXHAUSTED' })
  })

  it('normalizes Cloudflare 5xx failures', async () => {
    const { provider } = createProvider([
      { kind: 'response', status: 503, body: { errors: [{ message: 'upstream failed' }] } },
    ])

    await expect(
      provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT_UPSTREAM_FAILURE' })
  })

  it('normalizes a network connection failure', async () => {
    const { provider } = createProvider([
      { kind: 'throw', value: new TypeError('connect ECONNREFUSED api.cloudflare.com') },
    ])

    await expect(
      provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONNECTION_FAILED' })
  })

  it('sanitizes unknown and secret-bearing Cloudflare failures', async () => {
    const secret = 'Bearer provider-secret from upstream.internal.local'
    const unknownProvider = createProvider([{ kind: 'throw', value: new Error(secret) }]).provider
    const bodyProvider = createProvider([
      { kind: 'response', status: 500, body: { errors: [{ message: secret }] } },
    ]).provider

    for (const provider of [unknownProvider, bodyProvider]) {
      try {
        await provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 100 })
        expect.fail('Expected allocation to fail')
      } catch (error: unknown) {
        expect(JSON.stringify(error)).not.toContain(secret)
        expect(error instanceof Error ? error.stack : '').not.toContain(secret)
      }
    }
  })

  it('rejects unsupported long-session requests before fetching', async () => {
    const { provider, calls } = createProvider([{ kind: 'response', body: VALID_CREATE_RESPONSE }])

    await expect(
      provider.allocate(createKitesurfAllocateRequest({ maxSessionDurationMs: 600_001 }), {
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' })
    expect(calls).toHaveLength(0)
  })
})

describe('Kitesurf termination', () => {
  it('terminates successfully and treats a repeated call as already terminated', async () => {
    const { provider, calls } = createProvider([
      { kind: 'response', body: VALID_CREATE_RESPONSE },
      { kind: 'response', body: { status: 'closing' } },
    ])
    const session = await provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 100 })

    await expect(provider.terminate(session.reference, { timeoutMs: 100 })).resolves.toMatchObject({
      status: 'terminated',
    })
    await expect(provider.terminate(session.reference, { timeoutMs: 100 })).resolves.toMatchObject({
      status: 'already_terminated',
    })
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1)
  })

  it('coalesces concurrent termination without returning a late upstream failure', async () => {
    vi.useFakeTimers()
    const { provider, calls } = createProvider([
      { kind: 'response', body: VALID_CREATE_RESPONSE },
      { kind: 'delayed_body', body: { status: 'closing' }, delayMs: 100 },
    ])
    const session = await provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 200 })

    const first = provider.terminate(session.reference, { timeoutMs: 200 })
    const second = provider.terminate(session.reference, { timeoutMs: 200 })
    await vi.advanceTimersByTimeAsync(100)

    await expect(first).resolves.toMatchObject({ status: 'terminated' })
    await expect(second).resolves.toMatchObject({ status: 'already_terminated' })
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1)
  })

  it('lets a surviving joiner continue when the termination leader aborts', async () => {
    const { provider, calls } = createProvider([
      { kind: 'response', body: VALID_CREATE_RESPONSE },
      { kind: 'pending' },
      { kind: 'response', body: { status: 'closing' } },
    ])
    const session = await provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 200 })
    const leaderController = new AbortController()
    const leader = provider.terminate(session.reference, {
      timeoutMs: 200,
      signal: leaderController.signal,
    })
    const joiner = provider.terminate(session.reference, { timeoutMs: 200 })

    leaderController.abort()

    await expect(leader).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_ABORTED' })
    await expect(joiner).resolves.toMatchObject({ status: 'terminated' })
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(2)
  })

  it('re-arbitrates a surviving joiner with a third termination caller', async () => {
    vi.useFakeTimers()
    const { provider, calls } = createProvider([
      { kind: 'response', body: VALID_CREATE_RESPONSE },
      { kind: 'pending' },
      { kind: 'delayed_body', body: { status: 'closing' }, delayMs: 100 },
    ])
    const session = await provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 300 })
    const leaderController = new AbortController()
    const leader = provider.terminate(session.reference, {
      timeoutMs: 300,
      signal: leaderController.signal,
    })
    const joiner = provider.terminate(session.reference, { timeoutMs: 300 })

    leaderController.abort()
    await expect(leader).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_ABORTED' })
    const thirdCaller = provider.terminate(session.reference, { timeoutMs: 300 })
    await vi.advanceTimersByTimeAsync(100)

    await expect(joiner).resolves.toMatchObject({ status: 'terminated' })
    await expect(thirdCaller).resolves.toMatchObject({ status: 'already_terminated' })
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(2)
  })

  it('ends a joiner retry within the joiner original monotonic deadline', async () => {
    vi.useFakeTimers()
    let replacementAborted = false
    const { provider, calls } = createProvider(
      [
        { kind: 'response', body: VALID_CREATE_RESPONSE },
        { kind: 'pending' },
        { kind: 'pending', onAbort: () => (replacementAborted = true) },
      ],
      { monotonicNow: () => Date.now() },
    )
    const session = await provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 100 })
    const leader = provider.terminate(session.reference, { timeoutMs: 25 })
    const joiner = provider.terminate(session.reference, { timeoutMs: 50 })
    const leaderRejection = expect(leader).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_TIMEOUT',
    })
    const joinerRejection = expect(joiner).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_TIMEOUT',
    })

    await vi.advanceTimersByTimeAsync(25)
    await leaderRejection
    await vi.advanceTimersByTimeAsync(25)

    await joinerRejection
    expect(replacementAborted).toBe(true)
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(2)
  })

  it('lets the termination leader continue when a joiner aborts', async () => {
    vi.useFakeTimers()
    const { provider, calls } = createProvider([
      { kind: 'response', body: VALID_CREATE_RESPONSE },
      { kind: 'delayed_body', body: { status: 'closing' }, delayMs: 100 },
    ])
    const session = await provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 200 })
    const leader = provider.terminate(session.reference, { timeoutMs: 200 })
    const joinerController = new AbortController()
    const joiner = provider.terminate(session.reference, {
      timeoutMs: 200,
      signal: joinerController.signal,
    })

    joinerController.abort()
    await expect(joiner).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_ABORTED' })
    await vi.advanceTimersByTimeAsync(100)

    await expect(leader).resolves.toMatchObject({ status: 'terminated' })
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1)
  })

  it('bounds recently terminated session tracking and evicts the oldest entry', async () => {
    const responseSteps = Array.from({ length: 66 }, () => ({
      kind: 'response' as const,
      status: 404,
      body: { errors: [] },
    }))
    const { provider, calls } = createProvider(responseSteps)
    const references = Array.from({ length: 65 }, (_, index) =>
      ProviderSessionRefSchema.parse({
        providerID: 'cloudflare-browser-run',
        runtimeClass: 'kitesurf',
        providerSessionID: `bounded-session-${index}`,
      }),
    )

    for (const reference of references) {
      await provider.terminate(reference, { timeoutMs: 100 })
    }
    await provider.terminate(references[0]!, { timeoutMs: 100 })

    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(66)
  })

  it('expires recently terminated tracking with monotonic time', async () => {
    let monotonicNow = 10
    const { provider, calls } = createProvider(
      [
        { kind: 'response', status: 404, body: { errors: [] } },
        { kind: 'response', status: 404, body: { errors: [] } },
      ],
      { monotonicNow: () => monotonicNow },
    )
    const reference = ProviderSessionRefSchema.parse({
      providerID: 'cloudflare-browser-run',
      runtimeClass: 'kitesurf',
      providerSessionID: 'expiring-session',
    })

    await provider.terminate(reference, { timeoutMs: 100 })
    await provider.terminate(reference, { timeoutMs: 100 })
    monotonicNow += 10 * 60 * 1_000 + 1
    await provider.terminate(reference, { timeoutMs: 100 })

    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(2)
  })

  it('treats Cloudflare not found as already terminated', async () => {
    const { provider } = createProvider([
      { kind: 'response', body: VALID_CREATE_RESPONSE },
      { kind: 'response', status: 404, body: { errors: [{ message: 'not found' }] } },
    ])
    const session = await provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 100 })

    await expect(provider.terminate(session.reference, { timeoutMs: 100 })).resolves.toMatchObject({
      status: 'already_terminated',
    })
  })

  it('normalizes termination timeout', async () => {
    vi.useFakeTimers()
    const { provider } = createProvider([
      { kind: 'response', body: VALID_CREATE_RESPONSE },
      { kind: 'pending' },
    ])
    const session = await provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 100 })
    const termination = provider.terminate(session.reference, { timeoutMs: 25 })
    const rejection = expect(termination).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_TIMEOUT',
    })

    await vi.advanceTimersByTimeAsync(25)

    await rejection
  })

  it('normalizes termination 5xx without leaking its body', async () => {
    const secret = 'Bearer cleanup-secret from internal.provider.local'
    const { provider } = createProvider([
      { kind: 'response', body: VALID_CREATE_RESPONSE },
      { kind: 'response', status: 503, body: { errors: [{ message: secret }] } },
    ])
    const session = await provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 100 })

    try {
      await provider.terminate(session.reference, { timeoutMs: 100 })
      expect.fail('Expected termination to fail')
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'PROVIDER_TRANSIENT_UPSTREAM_FAILURE' })
      expect(JSON.stringify(error)).not.toContain(secret)
    }
  })
})
