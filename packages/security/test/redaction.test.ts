import { describe, expect, it } from 'vitest'

import { redactSensitiveData } from '../src/index.js'

describe('centralized sensitive-data redaction', () => {
  it('redacts nested secret fields case-insensitively without mutating the input', () => {
    const input = {
      headers: {
        Authorization: 'Bearer provider-secret',
        COOKIE: 'session=secret',
        Accept: 'application/json',
      },
      nested: [
        { relayToken: 'relay-secret', browserRunAPIToken: 'cloudflare-secret' },
        { password: 'database-secret', value: 'safe' },
      ],
    }

    expect(redactSensitiveData(input)).toEqual({
      headers: {
        Authorization: '[REDACTED]',
        COOKIE: '[REDACTED]',
        Accept: 'application/json',
      },
      nested: [
        { relayToken: '[REDACTED]', browserRunAPIToken: '[REDACTED]' },
        { password: '[REDACTED]', value: 'safe' },
      ],
    })
    expect(input.headers.Authorization).toBe('Bearer provider-secret')
  })

  it('sanitizes credentials and common secret query parameters in URL strings', () => {
    const redacted = redactSensitiveData({
      databaseURL: 'postgresql://user:password@db.example/surfgate',
      endpoint: 'wss://relay.example/cdp?token=secret&safe=value',
      callback: 'https://example.com/path?access_token=secret&code=public',
    })

    expect(JSON.stringify(redacted)).not.toContain('password')
    expect(JSON.stringify(redacted)).not.toContain('secret')
    expect(redacted).toEqual({
      databaseURL: '[REDACTED]',
      endpoint: 'wss://relay.example/cdp?token=%5BREDACTED%5D&safe=value',
      callback: 'https://example.com/path?access_token=%5BREDACTED%5D&code=public',
    })
  })

  it('handles cyclic structured data without throwing or retaining secrets', () => {
    const input: Record<string, unknown> = { authorization: 'Bearer secret' }
    input.self = input

    const redacted = redactSensitiveData(input)

    expect(redacted).toEqual({ authorization: '[REDACTED]', self: '[Circular]' })
  })

  it('redacts secret-shaped values even when an attacker places them under an innocuous key', () => {
    const apiKey = `sg_live_0123456789ab_${'A'.repeat(43)}`
    const relayToken = `sgrt.v1.v1.${'B'.repeat(64)}.${'C'.repeat(43)}`
    const protectedReference = `psr.v1.v1.${'D'.repeat(16)}.${'E'.repeat(24)}.${'F'.repeat(22)}`
    const redacted = redactSensitiveData({
      diagnostic: `upstream echoed Bearer provider-secret and ${apiKey}`,
      relayDiagnostic: relayToken,
      storageDiagnostic: protectedReference,
      upstreamError: 'request failed for wss://provider.example/cdp?token=upstream-secret',
      'X-API-Key': apiKey,
      client_secret: 'client-secret',
      privateKey: 'private-key',
    })
    const serialized = JSON.stringify(redacted)

    expect(serialized).not.toContain('provider-secret')
    expect(serialized).not.toContain(apiKey)
    expect(serialized).not.toContain(relayToken)
    expect(serialized).not.toContain(protectedReference)
    expect(serialized).not.toContain('upstream-secret')
    expect(redacted).toMatchObject({
      'X-API-Key': '[REDACTED]',
      client_secret: '[REDACTED]',
      privateKey: '[REDACTED]',
    })
  })
})
