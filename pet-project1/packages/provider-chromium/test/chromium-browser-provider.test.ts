import { ProviderDescriptorSchema, ProviderSessionSchema } from '@surfgate/provider-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CHROMIUM_CAPABILITIES,
  createChromiumBrowserProvider,
  type ChromiumBrowserProvider,
} from '../src/index.js'
import {
  CONFIGURED_CLOUDFLARE_CONFIG,
  TEST_API_TOKEN,
  TEST_NOW,
  TEST_SESSION_ID,
  UNCONFIGURED_CLOUDFLARE_CONFIG,
  VALID_CREATE_RESPONSE,
  createChromiumAllocateRequest,
} from './fixtures.js'
import { createScriptedFetch } from './test-transport.js'

afterEach(() => {
  vi.useRealTimers()
})

function createProvider(
  steps: Parameters<typeof createScriptedFetch>[0],
  options: Readonly<{ monotonicNow?: () => number }> = {},
): Readonly<{
  provider: ChromiumBrowserProvider
  calls: ReturnType<typeof createScriptedFetch>['calls']
}> {
  const transport = createScriptedFetch(steps, TEST_API_TOKEN)
  const provider = createChromiumBrowserProvider(CONFIGURED_CLOUDFLARE_CONFIG, {
    fetch: transport.fetch,
    now: () => TEST_NOW,
    monotonicNow: options.monotonicNow ?? (() => 10),
  })
  return { provider, calls: transport.calls }
}

describe('Chromium descriptor and health', () => {
  it('reports not configured without making a network call', async () => {
    const transport = createScriptedFetch([], TEST_API_TOKEN)
    const provider = createChromiumBrowserProvider(UNCONFIGURED_CLOUDFLARE_CONFIG, {
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

  it('returns a stable validated Chromium descriptor', () => {
    const { provider } = createProvider([])

    expect(ProviderDescriptorSchema.parse(provider.descriptor())).toEqual(provider.descriptor())
    expect(provider.descriptor()).toBe(provider.descriptor())
    expect(provider.descriptor()).toMatchObject({
      providerID: 'cloudflare-browser-run',
      runtimeClass: 'chromium',
      displayName: 'Cloudflare Browser Run — Chromium',
      configured: true,
    })
  })

  it('declares product capabilities conservatively', () => {
    expect(CHROMIUM_CAPABILITIES).toEqual({
      javascript: 'supported',
      dom: 'supported',
      xhr: 'supported',
      svg: 'supported',
      screenshot: 'supported',
      pdf: 'supported',
      webgl: 'supported',
      video: 'experimental',
      persistentAuth: 'supported',
      realBrowserTLS: 'supported',
      downloads: 'unknown',
      uploads: 'unknown',
      multiTab: 'supported',
      longSession: 'supported',
    })
  })

  it.each([
    [{ kind: 'response' as const, body: [] }, 'healthy'],
    [
      {
        kind: 'response' as const,
        status: 429,
        body: { errors: [] },
        headers: { 'retry-after': '2' },
      },
      'degraded',
    ],
    [{ kind: 'response' as const, status: 503, body: { errors: [] } }, 'unavailable'],
  ] as const)('normalizes provider infrastructure health as %s', async (step, status) => {
    const { provider } = createProvider([step])
    await expect(provider.health({ timeoutMs: 100 })).resolves.toMatchObject({ status })
  })

  it('does not claim capacity from a successful session-list probe', async () => {
    const { provider } = createProvider([{ kind: 'response', body: [] }])

    await expect(provider.health({ timeoutMs: 100 })).resolves.toMatchObject({
      status: 'healthy',
      capacity: 'unknown',
    })
  })
})

describe('Chromium allocation', () => {
  it('uses the stable Chromium endpoint without a Kitesurf selector', async () => {
    const { provider, calls } = createProvider([{ kind: 'response', body: VALID_CREATE_RESPONSE }])

    const session = await provider.allocate(createChromiumAllocateRequest(), { timeoutMs: 100 })

    expect(ProviderSessionSchema.parse(session)).toEqual(session)
    expect(session.reference).toMatchObject({
      providerID: 'cloudflare-browser-run',
      runtimeClass: 'chromium',
      providerSessionID: TEST_SESSION_ID,
    })
    const allocationURL = new URL(calls[0]?.url ?? '')
    expect(allocationURL.pathname).toContain('/browser-rendering/devtools/browser')
    expect(allocationURL.searchParams.has('browser')).toBe(false)
    expect(allocationURL.searchParams.get('keep_alive')).toBe('60000')
    expect(calls[0]).toMatchObject({
      method: 'POST',
      authorizationIsExpected: true,
      headerNames: ['authorization'],
      redirectPolicy: 'error',
    })
    expect(JSON.stringify(calls)).not.toContain(TEST_API_TOKEN)
    expect(new URL(session.connection.endpoint).search).toBe('')
  })

  it('clamps the inactivity keep-alive while preserving a longer requested lifetime', async () => {
    const { provider, calls } = createProvider([{ kind: 'response', body: VALID_CREATE_RESPONSE }])

    const session = await provider.allocate(
      createChromiumAllocateRequest({ maxSessionDurationMs: 3_600_000 }),
      { timeoutMs: 100 },
    )

    expect(new URL(calls[0]?.url ?? '').searchParams.get('keep_alive')).toBe('600000')
    expect(session.expiresAt).toBe('2026-08-08T01:00:00.000Z')
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
        '/browser-rendering/',
        '/browser-run/',
      ),
    },
  ] as const)('rejects an invalid allocation response: %s', async (body) => {
    const identityPresent = 'sessionId' in body
    const { provider } = createProvider([
      { kind: 'response', body },
      ...(identityPresent ? [{ kind: 'response' as const, body: { status: 'closing' } }] : []),
    ])

    await expect(
      provider.allocate(createChromiumAllocateRequest(), { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' })
  })

  it('rejects a non-Chromium runtime request before fetching', async () => {
    const { provider, calls } = createProvider([])

    await expect(
      provider.allocate(createChromiumAllocateRequest({ runtimeClass: 'kitesurf' }), {
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' })
    expect(calls).toHaveLength(0)
  })

  it('rejects an already aborted signal before fetching', async () => {
    const { provider, calls } = createProvider([])
    const controller = new AbortController()
    controller.abort()

    await expect(
      provider.allocate(createChromiumAllocateRequest(), {
        timeoutMs: 100,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_ABORTED' })
    expect(calls).toHaveLength(0)
  })

  it('honors cancellation during allocation', async () => {
    const { provider } = createProvider([{ kind: 'pending' }])
    const controller = new AbortController()
    const allocation = provider.allocate(createChromiumAllocateRequest(), {
      timeoutMs: 200,
      signal: controller.signal,
    })
    controller.abort()

    await expect(allocation).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_ABORTED' })
  })

  it('normalizes allocation timeout including response-body consumption', async () => {
    vi.useFakeTimers()
    const { provider } = createProvider([
      { kind: 'delayed_body', body: VALID_CREATE_RESPONSE, delayMs: 100 },
    ])
    const allocation = provider.allocate(createChromiumAllocateRequest(), { timeoutMs: 25 })
    const rejection = expect(allocation).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(25)
    await rejection
  })

  it.each([
    [401, 'PROVIDER_AUTHORIZATION_ERROR'],
    [403, 'PROVIDER_AUTHORIZATION_ERROR'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [503, 'PROVIDER_TRANSIENT_UPSTREAM_FAILURE'],
  ] as const)('normalizes HTTP %s as %s', async (status, code) => {
    const { provider } = createProvider([
      {
        kind: 'response',
        status,
        body: { errors: [] },
        ...(status === 429 ? { headers: { 'retry-after': '3' } } : {}),
      },
    ])

    await expect(
      provider.allocate(createChromiumAllocateRequest(), { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code })
  })

  it('classifies documented daily quota exhaustion as capacity exhaustion', async () => {
    const { provider } = createProvider([
      {
        kind: 'response',
        status: 429,
        body: { errors: [{ message: 'Browser time limit exceeded for today' }] },
      },
    ])

    await expect(
      provider.allocate(createChromiumAllocateRequest(), { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CAPACITY_EXHAUSTED' })
  })

  it.each([
    [{ kind: 'response' as const, body: 'not-a-session' }, 'PROVIDER_INVALID_RESPONSE'],
    [
      { kind: 'throw' as const, value: new TypeError('connect ECONNREFUSED api.cloudflare.com') },
      'PROVIDER_CONNECTION_FAILED',
    ],
  ] as const)('normalizes malformed/network allocation failures', async (step, code) => {
    const { provider } = createProvider([step])
    await expect(
      provider.allocate(createChromiumAllocateRequest(), { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code })
  })

  it('sanitizes unknown and secret-bearing upstream failures', async () => {
    const secret = 'Bearer provider-secret from upstream.internal.local Authorization'
    const provider = createProvider([{ kind: 'throw', value: new Error(secret) }]).provider

    try {
      await provider.allocate(createChromiumAllocateRequest(), { timeoutMs: 100 })
      expect.fail('Expected allocation to fail')
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'PROVIDER_UNKNOWN_ERROR' })
      expect(JSON.stringify(error)).not.toContain(secret)
      expect(error instanceof Error ? error.stack : '').not.toContain(secret)
    }
  })
})

describe('Chromium termination', () => {
  it('terminates successfully and treats the second call as already terminated', async () => {
    const { provider, calls } = createProvider([
      { kind: 'response', body: VALID_CREATE_RESPONSE },
      { kind: 'response', body: { status: 'closing' } },
    ])
    const session = await provider.allocate(createChromiumAllocateRequest(), { timeoutMs: 100 })

    await expect(provider.terminate(session.reference, { timeoutMs: 100 })).resolves.toMatchObject({
      status: 'terminated',
    })
    await expect(provider.terminate(session.reference, { timeoutMs: 100 })).resolves.toMatchObject({
      status: 'already_terminated',
    })
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1)
  })

  it('treats Cloudflare not found as already terminated', async () => {
    const { provider } = createProvider([
      { kind: 'response', body: VALID_CREATE_RESPONSE },
      { kind: 'response', status: 404, body: { errors: [] } },
    ])
    const session = await provider.allocate(createChromiumAllocateRequest(), { timeoutMs: 100 })

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
    const session = await provider.allocate(createChromiumAllocateRequest(), { timeoutMs: 100 })
    const termination = provider.terminate(session.reference, { timeoutMs: 25 })
    const rejection = expect(termination).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(25)
    await rejection
  })

  it.each([
    [
      { kind: 'response' as const, status: 401, body: { errors: [] } },
      'PROVIDER_AUTHORIZATION_ERROR',
    ],
    [
      { kind: 'response' as const, status: 403, body: { errors: [] } },
      'PROVIDER_AUTHORIZATION_ERROR',
    ],
    [{ kind: 'response' as const, status: 429, body: { errors: [] } }, 'PROVIDER_RATE_LIMITED'],
    [
      { kind: 'response' as const, status: 503, body: { errors: [] } },
      'PROVIDER_TRANSIENT_UPSTREAM_FAILURE',
    ],
    [{ kind: 'response' as const, body: { status: 'maybe' } }, 'PROVIDER_INVALID_RESPONSE'],
    [
      { kind: 'throw' as const, value: new TypeError('connection refused') },
      'PROVIDER_CONNECTION_FAILED',
    ],
  ] as const)('normalizes termination failure without raw details', async (step, code) => {
    const { provider } = createProvider([{ kind: 'response', body: VALID_CREATE_RESPONSE }, step])
    const session = await provider.allocate(createChromiumAllocateRequest(), { timeoutMs: 100 })

    await expect(provider.terminate(session.reference, { timeoutMs: 100 })).rejects.toMatchObject({
      code,
    })
  })
})
