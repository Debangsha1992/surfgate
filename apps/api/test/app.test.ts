import { Writable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { LivenessResponseSchema, RequestIDSchema } from '@surfgate/contracts'

import { FASTIFY_LOG_REDACTION_PATHS, buildAPIApplication } from '../src/app.js'
import { validatePublicResponse } from '../src/http/validation.js'

const REQUEST_ID = RequestIDSchema.parse('req_01ARZ3NDEKTSV4RRFFQ69G5FAV')

function createTelemetry() {
  return {
    recordHTTP: vi.fn(),
    recordAuthentication: vi.fn(),
    recordDatabaseHealth: vi.fn(),
    recordSessionTransition: vi.fn(),
  }
}

describe('Fastify control-plane foundation', () => {
  it('separates liveness from PostgreSQL-backed readiness', async () => {
    const telemetry = createTelemetry()
    const app = buildAPIApplication({
      databaseHealth: { health: vi.fn(() => Promise.resolve('unavailable' as const)) },
      telemetry,
      logger: false,
    })

    const live = await app.inject({ method: 'GET', url: '/health/live' })
    const ready = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(live.statusCode).toBe(200)
    expect(live.json()).toEqual({ status: 'alive' })
    expect(ready.statusCode).toBe(503)
    expect(ready.json()).toEqual({
      status: 'not_ready',
      dependencies: { postgres: 'unavailable' },
    })
    expect(telemetry.recordDatabaseHealth).toHaveBeenCalledWith('unavailable')
    await app.close()
  })

  it('bounds readiness when a dependency health check does not settle', async () => {
    vi.useFakeTimers()
    const app = buildAPIApplication({
      databaseHealth: {
        health: vi.fn(() => new Promise<'ready' | 'unavailable'>(() => undefined)),
      },
      telemetry: createTelemetry(),
      logger: false,
      readinessTimeoutMs: 100,
    })
    try {
      const responsePromise = app.inject({ method: 'GET', url: '/health/ready' })
      await vi.advanceTimersByTimeAsync(100)
      const response = await responsePromise

      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({
        status: 'not_ready',
        dependencies: { postgres: 'unavailable' },
      })
    } finally {
      await app.close()
      vi.useRealTimers()
    }
  })

  it('propagates only a valid SurfGate request ID and always returns one', async () => {
    const app = buildAPIApplication({
      databaseHealth: { health: vi.fn(() => Promise.resolve('ready' as const)) },
      telemetry: createTelemetry(),
      logger: false,
    })

    const propagated = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': REQUEST_ID },
    })
    const replaced = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'attacker-controlled-value' },
    })

    expect(propagated.headers['x-request-id']).toBe(REQUEST_ID)
    expect(RequestIDSchema.safeParse(replaced.headers['x-request-id']).success).toBe(true)
    expect(replaced.headers['x-request-id']).not.toBe('attacker-controlled-value')
    await app.close()
  })

  it('sets API-safe response headers without enabling permissive CORS', async () => {
    const app = buildAPIApplication({
      databaseHealth: { health: vi.fn(() => Promise.resolve('ready' as const)) },
      telemetry: createTelemetry(),
      logger: false,
    })

    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'https://attacker.example' },
    })

    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    await app.close()
  })

  it('normalizes unexpected errors without exposing secrets or stack traces', async () => {
    let logs = ''
    const stream = new Writable({
      write(chunk: string | Buffer, _encoding: BufferEncoding, callback) {
        logs += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        callback()
      },
    })
    const app = buildAPIApplication({
      databaseHealth: { health: vi.fn(() => Promise.resolve('ready' as const)) },
      telemetry: createTelemetry(),
      logger: { level: 'info', stream },
    })
    app.get('/_test/error', () => {
      throw new Error('Bearer sg_live_secret at postgres.internal.local')
    })

    const response = await app.inject({ method: 'GET', url: '/_test/error' })
    const serialized = response.body

    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({
      error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
    })
    expect(serialized).not.toContain('sg_live_secret')
    expect(serialized).not.toContain('postgres.internal.local')
    expect(serialized).not.toContain('stack')
    expect(logs).not.toContain('sg_live_secret')
    expect(logs).not.toContain('postgres.internal.local')
    expect(FASTIFY_LOG_REDACTION_PATHS).toContain('req.headers.authorization')
    await app.close()
  })

  it('turns response-schema violations into sanitized internal errors', async () => {
    const app = buildAPIApplication({
      databaseHealth: { health: vi.fn(() => Promise.resolve('ready' as const)) },
      telemetry: createTelemetry(),
      logger: false,
    })
    app.get('/_test/invalid-response', () =>
      validatePublicResponse(LivenessResponseSchema, {
        status: 'unsafe',
        secret: 'must-not-serialize',
      }),
    )

    const response = await app.inject({ method: 'GET', url: '/_test/invalid-response' })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } })
    expect(response.body).not.toContain('must-not-serialize')
    await app.close()
  })

  it.each([
    { name: 'malformed', payload: '{' },
    { name: 'empty', payload: '' },
  ])('normalizes $name JSON bodies as public validation errors', async ({ payload }) => {
    const app = buildAPIApplication({
      databaseHealth: { health: vi.fn(() => Promise.resolve('ready' as const)) },
      telemetry: createTelemetry(),
      logger: false,
    })
    app.post('/_test/json', () => ({ accepted: true }))

    const response = await app.inject({
      method: 'POST',
      url: '/_test/json',
      headers: { 'content-type': 'application/json' },
      payload,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: {
        code: 'VALIDATION_INVALID_REQUEST',
        message: 'The request is invalid.',
      },
    })
    expect(response.body).not.toContain('FST_ERR_CTP')
    await app.close()
  })

  it('does not expose production session endpoints before SG-0504', async () => {
    const app = buildAPIApplication({
      databaseHealth: { health: vi.fn(() => Promise.resolve('ready' as const)) },
      telemetry: createTelemetry(),
      logger: false,
    })

    const response = await app.inject({ method: 'POST', url: '/v1/sessions', payload: {} })
    expect(response.statusCode).toBe(404)
    await app.close()
  })
})
