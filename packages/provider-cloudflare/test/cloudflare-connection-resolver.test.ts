import { describe, expect, it } from 'vitest'

import { ProviderSessionSchema } from '@surfgate/provider-core'

import { resolveCloudflareBrowserRunConnection } from '../src/index.js'

const config = {
  apiBaseURL: new URL('https://api.cloudflare.com/client/v4'),
  credentials: {
    accountID: '0123456789abcdef0123456789abcdef',
    browserRunAPIToken: 'provider-secret-token',
  },
} as const

function session(runtimeClass: 'kitesurf' | 'chromium', namespace = 'browser-rendering') {
  const providerSessionID = '123e4567-e89b-12d3-a456-426614174000'
  return ProviderSessionSchema.parse({
    reference: { providerID: 'cloudflare-browser-run', runtimeClass, providerSessionID },
    connection: {
      transport: 'websocket',
      endpoint: `wss://api.cloudflare.com/client/v4/accounts/${config.credentials.accountID}/${namespace}/devtools/browser/${providerSessionID}`,
      credentialReference: `cloudflare-browser-run:${providerSessionID}`,
    },
    allocatedAt: '2026-08-09T00:00:00.000Z',
    expiresAt: '2026-08-09T00:10:00.000Z',
    metadata: { configProfile: runtimeClass },
  })
}

describe('Cloudflare relay connection resolver', () => {
  it('resolves internal authorization without altering the validated endpoint', () => {
    const resolved = resolveCloudflareBrowserRunConnection(config, session('chromium'))
    expect(resolved.endpoint).toContain('/browser-rendering/devtools/browser/')
    expect(resolved.headers).toEqual({ Authorization: 'Bearer provider-secret-token' })
    expect(JSON.stringify(resolved)).toContain('provider-secret-token')
  })

  it('rejects configuration, identity, credential-reference, and namespace mismatches', () => {
    expect(() =>
      resolveCloudflareBrowserRunConnection(
        { ...config, credentials: undefined },
        session('chromium'),
      ),
    ).toThrow()
    expect(() =>
      resolveCloudflareBrowserRunConnection(
        config,
        ProviderSessionSchema.parse({
          ...session('chromium'),
          connection: { ...session('chromium').connection, credentialReference: 'wrong' },
        }),
      ),
    ).toThrow()
    expect(() =>
      resolveCloudflareBrowserRunConnection(config, session('chromium', 'browser-run')),
    ).toThrow()
  })
})
