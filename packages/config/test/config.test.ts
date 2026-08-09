import { describe, expect, it } from 'vitest'

import { ConfigurationError, parseConfig } from '../src/index.js'

const VALID_DEVELOPMENT_ENVIRONMENT = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  SURFGATE_API_HOST: '127.0.0.1',
  SURFGATE_API_PORT: '8080',
  SURFGATE_RELAY_HOST: '127.0.0.1',
  SURFGATE_RELAY_PORT: '8081',
  SURFGATE_RELAY_PUBLIC_URL: 'ws://127.0.0.1:8081',
  DATABASE_URL: 'postgresql://surfgate:surfgate@127.0.0.1:5432/surfgate',
  REDIS_URL: 'redis://127.0.0.1:6379',
  S3_REGION: 'auto',
  S3_BUCKET: 'surfgate-dev',
  OTEL_SERVICE_NAME: 'surfgate',
} as const

const VALID_PRODUCTION_ENVIRONMENT = {
  ...VALID_DEVELOPMENT_ENVIRONMENT,
  NODE_ENV: 'production',
  SURFGATE_RELAY_PUBLIC_URL: 'wss://relay.surfgate.example',
  DATABASE_URL: 'postgresql://surfgate@database.surfgate.example/surfgate?sslmode=require',
  REDIS_URL: 'rediss://redis.surfgate.example:6379',
  S3_ENDPOINT: 'https://objects.surfgate.example',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://telemetry.surfgate.example',
  SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  SURFGATE_RELAY_TOKEN_SIGNING_KEY: Buffer.alloc(32, 8).toString('base64'),
} as const

describe('parseConfig', () => {
  it('returns strongly grouped development configuration', () => {
    const config = parseConfig(VALID_DEVELOPMENT_ENVIRONMENT)

    expect(config.runtime).toEqual({ environment: 'development', logLevel: 'info' })
    expect(config.api).toEqual({ host: '127.0.0.1', port: 8080 })
    expect(config.relay).toMatchObject({ host: '127.0.0.1', port: 8081 })
    expect(config.relay.publicURL.href).toBe('ws://127.0.0.1:8081/')
    expect(config.relay).toMatchObject({
      absoluteTimeoutMs: 3_600_000,
      authorizationCheckIntervalMs: 2_000,
      connectTimeoutMs: 10_000,
      drainTimeoutMs: 10_000,
      idleTimeoutMs: 60_000,
      leaseTTLms: 15_000,
      maxMessageBytes: 8_388_608,
      maxQueuedBytes: 16_777_216,
      tokenTTLSeconds: 60,
    })
    expect(config.database.url.protocol).toBe('postgresql:')
    expect(config.database.testURL).toBeUndefined()
    expect(config.redis.url.protocol).toBe('redis:')
    expect(config.objectStorage).toEqual({
      bucket: 'surfgate-dev',
      credentials: undefined,
      endpoint: undefined,
      region: 'auto',
    })
    expect(config.telemetry).toEqual({ endpoint: undefined, serviceName: 'surfgate' })
    expect(config.cloudflare).toEqual({
      apiBaseURL: new URL('https://api.cloudflare.com/client/v4'),
      credentials: undefined,
    })
    expect(config.controlPlane).toEqual({
      allocationTimeoutMs: 30_000,
      healthTimeoutMs: 5_000,
      idempotencyWaitTimeoutMs: 35_000,
      quotas: {
        maxConcurrentSessions: 10,
        maxSessionDurationSeconds: 600,
        requestsPerMinute: 60,
      },
      terminationTimeoutMs: 15_000,
    })
  })

  it('accepts secure production transports', () => {
    const config = parseConfig(VALID_PRODUCTION_ENVIRONMENT)

    expect(config.runtime.environment).toBe('production')
    expect(config.relay.publicURL.protocol).toBe('wss:')
    expect(config.redis.url.protocol).toBe('rediss:')
  })

  it.each([
    ['SURFGATE_RELAY_PUBLIC_URL', 'ws://relay.surfgate.example'],
    ['DATABASE_URL', 'postgresql://surfgate@database.surfgate.example/surfgate'],
    ['REDIS_URL', 'redis://redis.surfgate.example:6379'],
    ['S3_ENDPOINT', 'http://objects.surfgate.example'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'http://telemetry.surfgate.example'],
  ] as const)('rejects insecure production transport for %s', (key, value) => {
    expect(() => parseConfig({ ...VALID_PRODUCTION_ENVIRONMENT, [key]: value })).toThrowError(
      new RegExp(key),
    )
  })

  it.each(['DATABASE_URL', 'REDIS_URL', 'S3_REGION', 'S3_BUCKET'] as const)(
    'rejects a missing required %s value',
    (key) => {
      expect(() =>
        parseConfig({ ...VALID_DEVELOPMENT_ENVIRONMENT, [key]: undefined }),
      ).toThrowError(new RegExp(key))
    },
  )

  it.each([
    ['SURFGATE_API_PORT', '0'],
    ['SURFGATE_API_PORT', '65536'],
    ['SURFGATE_API_PORT', '8080.5'],
    ['SURFGATE_API_PORT', 'not-a-port'],
    ['SURFGATE_RELAY_PORT', 'not-a-port'],
  ] as const)('rejects malformed %s value %s', (key, value) => {
    expect(() => parseConfig({ ...VALID_DEVELOPMENT_ENVIRONMENT, [key]: value })).toThrowError(
      new RegExp(key),
    )
  })

  it.each([
    ['SURFGATE_QUOTA_REQUESTS_PER_MINUTE', '0'],
    ['SURFGATE_QUOTA_MAX_CONCURRENT_SESSIONS', '-1'],
    ['SURFGATE_QUOTA_MAX_SESSION_DURATION_SECONDS', '86401'],
    ['SURFGATE_PROVIDER_HEALTH_TIMEOUT_MS', 'not-a-number'],
    ['SURFGATE_PROVIDER_ALLOCATION_TIMEOUT_MS', '0'],
    ['SURFGATE_PROVIDER_TERMINATION_TIMEOUT_MS', '700000'],
    ['SURFGATE_IDEMPOTENCY_WAIT_TIMEOUT_MS', '0'],
  ] as const)('rejects invalid control-plane setting %s', (key, value) => {
    expect(() => parseConfig({ ...VALID_DEVELOPMENT_ENVIRONMENT, [key]: value })).toThrowError(
      new RegExp(key),
    )
  })

  it.each([
    ['DATABASE_URL', 'https://database.example.test'],
    ['REDIS_URL', 'https://redis.example.test'],
    ['SURFGATE_RELAY_PUBLIC_URL', 'https://relay.example.test'],
    ['SURFGATE_RELAY_PUBLIC_URL', 'wss://user@relay.example.test'],
    ['SURFGATE_RELAY_PUBLIC_URL', 'wss://relay.example.test/?token=secret'],
    ['S3_ENDPOINT', 'not a URL'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'file:///tmp/telemetry'],
    ['CLOUDFLARE_API_BASE_URL', 'http://api.cloudflare.test'],
    ['CLOUDFLARE_API_BASE_URL', 'https://attacker.example/client/v4'],
    ['CLOUDFLARE_API_BASE_URL', 'https://api.cloudflare.com:444/client/v4'],
    ['CLOUDFLARE_API_BASE_URL', 'https://user@api.cloudflare.com/client/v4'],
    ['CLOUDFLARE_API_BASE_URL', 'https://api.cloudflare.com/client/v4?redirect=attacker'],
  ] as const)('rejects invalid URL configuration for %s', (key, value) => {
    expect(() => parseConfig({ ...VALID_DEVELOPMENT_ENVIRONMENT, [key]: value })).toThrowError(
      new RegExp(key),
    )
  })

  it('keeps Cloudflare credentials optional', () => {
    const config = parseConfig(VALID_DEVELOPMENT_ENVIRONMENT)

    expect(config.cloudflare.credentials).toBeUndefined()
  })

  it('parses a 32-byte provider-session encryption key without retaining its source text', () => {
    const encodedKey = Buffer.alloc(32, 7).toString('base64')
    const config = parseConfig({
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY: encodedKey,
      SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY_ID: 'local-v1',
    })

    expect(config.security.providerSessionEncryption?.key.symmetricKeySize).toBe(32)
    expect(config.security.providerSessionEncryption?.keyID).toBe('local-v1')
    expect(JSON.stringify(config)).not.toContain(encodedKey)
  })

  it('parses relay-token signing material without retaining its source text', () => {
    const encodedKey = Buffer.alloc(32, 6).toString('base64')
    const config = parseConfig({
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      SURFGATE_RELAY_TOKEN_SIGNING_KEY: encodedKey,
      SURFGATE_RELAY_TOKEN_SIGNING_KEY_ID: 'relay-local-v1',
    })

    expect(config.security.relayTokenSigning?.key.symmetricKeySize).toBe(32)
    expect(config.security.relayTokenSigning?.keyID).toBe('relay-local-v1')
    expect(JSON.stringify(config)).not.toContain(encodedKey)
  })

  it('accepts an optional dedicated test database URL', () => {
    const config = parseConfig({
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      TEST_DATABASE_URL: 'postgresql://surfgate:surfgate@127.0.0.1:5432/surfgate_test',
    })

    expect(config.database.testURL?.pathname).toBe('/surfgate_test')
  })

  it('rejects an invalid provider-session encryption key without echoing it', () => {
    const invalidKey = 'not-a-valid-32-byte-secret'

    expect(() =>
      parseConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY: invalidKey,
      }),
    ).toThrowError(/SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY/u)

    try {
      parseConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY: invalidKey,
      })
      expect.fail('Expected invalid encryption configuration to throw')
    } catch (error: unknown) {
      expect(error instanceof Error ? error.message : '').not.toContain(invalidKey)
    }
  })

  it('requires provider-session encryption in production', () => {
    const { SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY: _key, ...withoutEncryptionKey } =
      VALID_PRODUCTION_ENVIRONMENT
    expect(() => parseConfig(withoutEncryptionKey)).toThrowError(
      /SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY/u,
    )
    expect(_key).toBeDefined()
  })

  it('requires relay-token signing material in production', () => {
    const { SURFGATE_RELAY_TOKEN_SIGNING_KEY: _key, ...withoutRelaySigningKey } =
      VALID_PRODUCTION_ENVIRONMENT
    expect(() => parseConfig(withoutRelaySigningKey)).toThrowError(
      /SURFGATE_RELAY_TOKEN_SIGNING_KEY/u,
    )
    expect(_key).toBeDefined()
  })

  it('rejects weak relay-token signing material without echoing it', () => {
    const weakKey = Buffer.alloc(16, 4).toString('base64')
    expect(() =>
      parseConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        SURFGATE_RELAY_TOKEN_SIGNING_KEY: weakKey,
      }),
    ).toThrowError(/SURFGATE_RELAY_TOKEN_SIGNING_KEY/u)
    try {
      parseConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        SURFGATE_RELAY_TOKEN_SIGNING_KEY: weakKey,
      })
      expect.fail('Expected weak signing material to throw')
    } catch (error: unknown) {
      expect(error instanceof Error ? error.message : '').not.toContain(weakKey)
    }
  })

  it('accepts a complete optional Cloudflare credential pair', () => {
    const config = parseConfig({
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      CLOUDFLARE_BROWSER_RUN_API_TOKEN: 'token-value',
    })

    expect(config.cloudflare.credentials).toEqual({
      accountID: '0123456789abcdef0123456789abcdef',
      browserRunAPIToken: 'token-value',
    })
  })

  it('rejects a malformed Cloudflare account ID without echoing it', () => {
    const malformedAccountID = 'not-an-account-id'

    expect(() =>
      parseConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        CLOUDFLARE_ACCOUNT_ID: malformedAccountID,
        CLOUDFLARE_BROWSER_RUN_API_TOKEN: 'token-value',
      }),
    ).toThrowError(/CLOUDFLARE_ACCOUNT_ID/u)

    try {
      parseConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        CLOUDFLARE_ACCOUNT_ID: malformedAccountID,
        CLOUDFLARE_BROWSER_RUN_API_TOKEN: 'token-value',
      })
      expect.fail('Expected malformed Cloudflare account configuration to throw')
    } catch (error: unknown) {
      expect(error instanceof Error ? error.message : '').not.toContain(malformedAccountID)
    }
  })

  it('rejects incomplete Cloudflare credentials', () => {
    expect(() =>
      parseConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        CLOUDFLARE_BROWSER_RUN_API_TOKEN: 'token-value',
      }),
    ).toThrowError(/CLOUDFLARE_ACCOUNT_ID/u)
  })

  it('never includes rejected secret values in validation output', () => {
    const secret = 'do-not-print-this-secret'

    try {
      parseConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        CLOUDFLARE_BROWSER_RUN_API_TOKEN: secret,
        DATABASE_URL: `not-a-url-${secret}`,
      })
      expect.fail('Expected invalid configuration to throw')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigurationError)
      if (error instanceof ConfigurationError) {
        expect(error.message).not.toContain(secret)
        expect(error.stack).not.toContain(secret)
        expect(error.issues).not.toContain(secret)
        expect(error.cause).toBeUndefined()
        expect(JSON.stringify(error)).not.toContain(secret)
      }
    }
  })
})
