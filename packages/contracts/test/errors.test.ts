import { describe, expect, it } from 'vitest'

import {
  RequestIDSchema,
  SURFGATE_ERROR_MESSAGES,
  SurfGateErrorCodeSchema,
  SurfGateErrorResponseSchema,
  createSurfGateErrorResponse,
} from '../src/index.js'

const REQUEST_ID = RequestIDSchema.parse('req_01ARZ3NDEKTSV4RRFFQ69G5FAV')

describe('SurfGate public errors', () => {
  it('validates a provider-neutral public error response', () => {
    const result = SurfGateErrorResponseSchema.parse({
      error: {
        code: 'ROUTING_NO_COMPATIBLE_RUNTIME',
        message: 'No runtime satisfies the requested capabilities.',
        requestId: REQUEST_ID,
        details: {
          rejectedCandidates: ['kitesurf', 'chromium'],
        },
      },
    })

    expect(result.error.code).toBe('ROUTING_NO_COMPATIBLE_RUNTIME')
    expect(result.error.details).toEqual({
      rejectedCandidates: ['kitesurf', 'chromium'],
    })
  })

  it('accepts an error without optional details', () => {
    expect(
      SurfGateErrorResponseSchema.safeParse({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An internal error occurred.',
          requestId: REQUEST_ID,
        },
      }).success,
    ).toBe(true)
  })

  it('rejects an unregistered error code', () => {
    expect(SurfGateErrorCodeSchema.safeParse('SOMETHING_BROKE').success).toBe(false)
  })

  it('rejects an error without a request ID', () => {
    expect(
      SurfGateErrorResponseSchema.safeParse({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An internal error occurred.',
        },
      }).success,
    ).toBe(false)
  })

  it('rejects non-canonical public messages', () => {
    expect(
      SurfGateErrorResponseSchema.safeParse({
        error: {
          code: 'PROVIDER_UPSTREAM_ERROR',
          message: 'Raw upstream failure from internal.provider.local',
          requestId: REQUEST_ID,
        },
      }).success,
    ).toBe(false)
  })

  it.each([
    ['stack', { stack: 'at allocate (provider.ts:1:1)' }],
    ['authorization header', { authorization: 'Bearer provider-secret' }],
    ['provider token', { providerApiToken: 'provider-secret' }],
    ['raw provider error', { rawProviderError: { message: 'upstream failure' } }],
    ['internal hostname', { internalHostname: 'postgres.internal.local' }],
    ['nested secret', { diagnostic: { password: 'database-secret' } }],
  ])('rejects details containing a %s', (_name, details) => {
    expect(
      SurfGateErrorResponseSchema.safeParse({
        error: {
          code: 'PROVIDER_UPSTREAM_ERROR',
          message: 'The runtime provider returned an upstream error.',
          requestId: REQUEST_ID,
          details,
        },
      }).success,
    ).toBe(false)
  })

  it('rejects forbidden fields even when they use a parsed prototype key', () => {
    const details: unknown = JSON.parse('{"__proto__":{"polluted":true}}')

    expect(
      SurfGateErrorResponseSchema.safeParse({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An internal error occurred.',
          requestId: REQUEST_ID,
          details,
        },
      }).success,
    ).toBe(false)
  })

  it('rejects unexpected fields on the response and error objects', () => {
    expect(
      SurfGateErrorResponseSchema.safeParse({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An internal error occurred.',
          requestId: REQUEST_ID,
          stack: 'internal stack',
        },
        upstreamAuthorization: 'Bearer secret',
      }).success,
    ).toBe(false)
  })

  it('rejects sensitive values hidden behind innocuous detail keys', () => {
    expect(
      SurfGateErrorResponseSchema.safeParse({
        error: {
          code: 'PROVIDER_UPSTREAM_ERROR',
          message: 'The runtime provider returned an upstream error.',
          requestId: REQUEST_ID,
          details: {
            diagnostic: 'Bearer provider-secret',
            host: 'postgres.internal.local',
            message: 'raw provider response',
          },
        },
      }).success,
    ).toBe(false)
  })

  it('rejects non-runtime values inside the allowed rejected-candidate detail', () => {
    expect(
      SurfGateErrorResponseSchema.safeParse({
        error: {
          code: 'ROUTING_NO_COMPATIBLE_RUNTIME',
          message: 'No runtime satisfies the requested capabilities.',
          requestId: REQUEST_ID,
          details: { rejectedCandidates: ['Bearer provider-secret'] },
        },
      }).success,
    ).toBe(false)
  })

  it('constructs a canonical response without accepting an arbitrary message', () => {
    const response = createSurfGateErrorResponse({
      code: 'ROUTING_NO_COMPATIBLE_RUNTIME',
      requestId: REQUEST_ID,
      details: { rejectedCandidates: ['kitesurf'] },
    })

    expect(response.error.message).toBe(SURFGATE_ERROR_MESSAGES.ROUTING_NO_COMPATIBLE_RUNTIME)
    expect(JSON.stringify(response)).not.toContain('provider-secret')
  })
})
