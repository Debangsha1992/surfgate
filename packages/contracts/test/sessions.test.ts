import { describe, expect, it } from 'vitest'

import {
  IdempotencyKeySchema,
  PublicSessionSchema,
  RelayTokenResponseSchema,
  SessionCreateRequestSchema,
  SessionTerminationResponseSchema,
} from '../src/index.js'

const SESSION_ID = 'ses_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const DECISION_ID = 'rtd_01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('v1 session contracts', () => {
  it('normalizes a provider-neutral create request', () => {
    expect(
      SessionCreateRequestSchema.parse({
        targetUrl: 'https://example.com/',
        capabilities: { javascript: 'required', screenshot: 'preferred' },
        runtime: { preference: 'auto', allowFallback: true, allowExperimental: false },
        maxDurationSeconds: 300,
        metadata: { application: 'agent-runner', tags: ['safe', 'test'] },
      }),
    ).toEqual({
      targetUrl: 'https://example.com/',
      capabilities: { javascript: 'required', screenshot: 'preferred' },
      runtime: { preference: 'auto', allowFallback: true, allowExperimental: false },
      maxDurationSeconds: 300,
      metadata: { application: 'agent-runner', tags: ['safe', 'test'] },
    })
  })

  it('applies deterministic request defaults', () => {
    expect(SessionCreateRequestSchema.parse({})).toEqual({
      capabilities: {},
      runtime: { preference: 'auto', allowFallback: true, allowExperimental: false },
      maxDurationSeconds: 600,
    })
  })

  it.each([
    { capabilities: { stealth: 'required' } },
    { targetUrl: 'file:///etc/passwd' },
    { maxDurationSeconds: 0 },
    { metadata: { apiToken: 'secret' } },
  ])('rejects invalid or provider-specific request input', (request) => {
    expect(SessionCreateRequestSchema.safeParse(request).success).toBe(false)
  })

  it('accepts bounded opaque idempotency keys', () => {
    expect(IdempotencyKeySchema.parse('client-request_01')).toBe('client-request_01')
    expect(IdempotencyKeySchema.safeParse('Bearer secret\n').success).toBe(false)
    expect(IdempotencyKeySchema.safeParse('x'.repeat(129)).success).toBe(false)
  })

  it('validates a public-safe active session and rejects provider internals', () => {
    const session = {
      id: SESSION_ID,
      status: 'active',
      runtime: { runtimeClass: 'kitesurf', providerId: 'cloudflare-browser-run' },
      routing: {
        decisionId: DECISION_ID,
        reasonCodes: ['CAPABILITIES_SATISFIED', 'FAST_PATH_PREFERRED'],
        fallbackOccurred: false,
      },
      createdAt: '2026-08-09T00:00:00.000Z',
      connectedAt: '2026-08-09T00:00:01.000Z',
      expiresAt: '2026-08-09T00:10:01.000Z',
      terminatedAt: null,
    }
    expect(PublicSessionSchema.parse(session)).toEqual(session)
    expect(
      PublicSessionSchema.safeParse({
        ...session,
        providerSessionReference: 'secret',
        relay: { webSocketUrl: 'wss://upstream.example/secret' },
      }).success,
    ).toBe(false)
  })

  it('validates idempotent termination without relay/provider fields', () => {
    expect(
      SessionTerminationResponseSchema.parse({
        session: {
          id: SESSION_ID,
          status: 'terminated',
          runtime: { runtimeClass: 'chromium', providerId: 'cloudflare-browser-run' },
          routing: {
            decisionId: DECISION_ID,
            reasonCodes: ['CAPABILITIES_SATISFIED'],
            fallbackOccurred: true,
          },
          createdAt: '2026-08-09T00:00:00.000Z',
          connectedAt: '2026-08-09T00:00:01.000Z',
          expiresAt: '2026-08-09T00:10:01.000Z',
          terminatedAt: '2026-08-09T00:02:00.000Z',
        },
      }).session.status,
    ).toBe('terminated')
  })

  it('validates a short-lived SurfGate relay credential without provider internals', () => {
    const response = {
      webSocketUrl: `${'wss://relay.surfgate.example/v1/sessions/'}${SESSION_ID}/cdp`,
      token: `sgrt.v1.local.${'A'.repeat(64)}.${'B'.repeat(43)}`,
      expiresAt: '2026-08-09T00:01:00.000Z',
    }

    expect(RelayTokenResponseSchema.parse(response)).toEqual(response)
    expect(
      RelayTokenResponseSchema.safeParse({
        ...response,
        webSocketUrl: 'wss://api.cloudflare.com/client/v4/accounts/secret',
      }).success,
    ).toBe(false)
    expect(
      RelayTokenResponseSchema.safeParse({
        ...response,
        webSocketUrl: `wss://token@relay.surfgate.example/v1/sessions/${SESSION_ID}/cdp`,
      }).success,
    ).toBe(false)
  })
})
