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
  DATABASE_URL: 'postgresql://surfgate@database.surfgate.example/surfgate?sslmode=verify-full',
  REDIS_URL: 'rediss://redis.surfgate.example:6379',
  S3_ENDPOINT: 'https://objects.surfgate.example',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://telemetry.surfgate.example',
  SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY: Buffer.from(
    '2f6c986f2f85b0420b506c412bea1925d29c4827d4a6362041f00306e4cb385c',
    'hex',
  ).toString('base64'),
  SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY_ID: 'provider-session-v1',
  SURFGATE_RELAY_TOKEN_SIGNING_KEY: Buffer.from(
    '9f0b12ca173e2ae8d292cf86014e434ff24d2fe7a527225633df66228774ecac',
    'hex',
  ).toString('base64'),
  SURFGATE_RELAY_TOKEN_SIGNING_KEY_ID: 'relay-token-v1',
  CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  CLOUDFLARE_BROWSER_RUN_API_TOKEN: 'production-provider-token',
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
    expect(config.database.requiredMigration).toBe('0014-session-reconciliation-claim-index.sql')
    expect(config.database.testURL).toBeUndefined()
    expect(config.redis.url.protocol).toBe('redis:')
    expect(config.objectStorage).toEqual({
      bucket: 'surfgate-dev',
      credentials: undefined,
      endpoint: undefined,
      region: 'auto',
    })
    expect(config.telemetry).toEqual({
      endpoint: undefined,
      serviceName: 'surfgate',
      exportIntervalMs: 10_000,
      exportTimeoutMs: 5_000,
      shutdownTimeoutMs: 5_000,
      maxQueueSize: 2_048,
      maxExportBatchSize: 512,
      metricCardinalityLimit: 128,
    })
    expect(config.cloudflare).toEqual({
      apiBaseURL: new URL('https://api.cloudflare.com/client/v4'),
      credentials: undefined,
    })
    expect(config.controlPlane).toEqual({
      allocationTimeoutMs: 30_000,
      healthTimeoutMs: 5_000,
      idempotencyWaitTimeoutMs: 35_000,
      reconciliationBatchSize: 100,
      reconciliationStaleAfterMs: 120_000,
      quotas: {
        maxConcurrentSessions: 10,
        maxSessionDurationSeconds: 600,
        requestsPerMinute: 60,
      },
      terminationTimeoutMs: 15_000,
    })
    expect(config.tasks).toEqual({
      artifactMaxBytes: 16_777_216,
      artifactRetentionSeconds: 86_400,
      executionTimeoutMs: 30_000,
      extractMaxBytes: 1_048_576,
      leaseTTLms: 60_000,
      maxAttempts: 3,
      maxQueuedPerTenant: 100,
      maxRunningPerTenant: 5,
      pollIntervalMs: 250,
      requestsPerMinute: 120,
      screenshotMaxPixels: 33_554_432,
    })
    expect(config.worker).toEqual({
      healthHost: '127.0.0.1',
      healthPort: 8082,
      readinessTimeoutMs: 5_000,
      drainTimeoutMs: 10_000,
    })
  })

  it('accepts secure production transports', () => {
    const config = parseConfig(VALID_PRODUCTION_ENVIRONMENT)

    expect(config.runtime.environment).toBe('production')
    expect(config.relay.publicURL.protocol).toBe('wss:')
    expect(config.redis.url.protocol).toBe('rediss:')
    expect(config.security.rawCDPAccess).toBe('disabled')
  })

  it('requires an explicit trusted deployment decision to enable raw CDP in production', () => {
    const config = parseConfig({
      ...VALID_PRODUCTION_ENVIRONMENT,
      SURFGATE_RAW_CDP_ACCESS: 'trusted',
    })

    expect(config.security.rawCDPAccess).toBe('trusted')
  })

  it('uses the development raw-CDP default for an explicit empty value', () => {
    const config = parseConfig({
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      SURFGATE_RAW_CDP_ACCESS: '',
    })

    expect(config.security.rawCDPAccess).toBe('trusted')
  })

  it('uses the production raw-CDP default for an explicit empty value', () => {
    const config = parseConfig({
      ...VALID_PRODUCTION_ENVIRONMENT,
      SURFGATE_RAW_CDP_ACCESS: '',
    })

    expect(config.security.rawCDPAccess).toBe('disabled')
  })

  it('rejects obvious development key material in production', () => {
    expect(() =>
      parseConfig({
        ...VALID_PRODUCTION_ENVIRONMENT,
        SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      }),
    ).toThrowError(/SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY/u)
  })

  it('rejects key reuse across production cryptographic purposes', () => {
    expect(() =>
      parseConfig({
        ...VALID_PRODUCTION_ENVIRONMENT,
        SURFGATE_RELAY_TOKEN_SIGNING_KEY:
          VALID_PRODUCTION_ENVIRONMENT.SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY,
      }),
    ).toThrowError(/SURFGATE_RELAY_TOKEN_SIGNING_KEY/u)
  })

  it('rejects cross-purpose key reuse across rotation overlap sets', () => {
    expect(() =>
      parseConfig({
        ...VALID_PRODUCTION_ENVIRONMENT,
        SURFGATE_PROVIDER_SESSION_ENCRYPTION_PREVIOUS_KEY:
          VALID_PRODUCTION_ENVIRONMENT.SURFGATE_RELAY_TOKEN_SIGNING_KEY,
        SURFGATE_PROVIDER_SESSION_ENCRYPTION_PREVIOUS_KEY_ID: 'provider-old',
      }),
    ).toThrowError(/SURFGATE_RELAY_TOKEN_SIGNING_KEY/u)
  })

  it.each([
    ['DATABASE_URL', 'postgresql://surfgate@127.0.0.1/surfgate?sslmode=verify-full'],
    ['REDIS_URL', 'rediss://localhost:6379'],
    ['S3_ENDPOINT', 'https://127.0.0.1:9000'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'https://telemetry.localhost'],
    ['DATABASE_URL', 'postgresql://surfgate@[::1]/surfgate?sslmode=verify-full'],
    ['REDIS_URL', 'rediss://[::]:6379'],
    ['S3_ENDPOINT', 'https://[::ffff:127.0.0.1]:9000'],
  ] as const)('rejects local production dependency host for %s', (key, value) => {
    expect(() => parseConfig({ ...VALID_PRODUCTION_ENVIRONMENT, [key]: value })).toThrowError(
      new RegExp(key),
    )
  })

  it('parses previous encryption and signing keys for staged rotation', () => {
    const config = parseConfig({
      ...VALID_PRODUCTION_ENVIRONMENT,
      SURFGATE_PROVIDER_SESSION_ENCRYPTION_PREVIOUS_KEY: Buffer.from(
        'ed702e448be96c0072fbe2c7a860779ad50d112e840c5cc078ce5df319cf9885',
        'hex',
      ).toString('base64'),
      SURFGATE_PROVIDER_SESSION_ENCRYPTION_PREVIOUS_KEY_ID: 'provider-old',
      SURFGATE_RELAY_TOKEN_SIGNING_PREVIOUS_KEY: Buffer.from(
        'ee2764ce9bf12fa58d6efde476e987b2fafdd72fbbf6b1b93d774439b546ba72',
        'hex',
      ).toString('base64'),
      SURFGATE_RELAY_TOKEN_SIGNING_PREVIOUS_KEY_ID: 'relay-old',
    })

    expect(config.security.providerSessionEncryption?.decryptionKeys).toHaveLength(1)
    expect(config.security.providerSessionEncryption?.decryptionKeys[0]?.keyID).toBe('provider-old')
    expect(config.security.relayTokenSigning?.verificationKeys).toHaveLength(1)
    expect(config.security.relayTokenSigning?.verificationKeys[0]?.keyID).toBe('relay-old')
  })

  it('rejects incomplete or duplicate rotation keys', () => {
    expect(() =>
      parseConfig({
        ...VALID_PRODUCTION_ENVIRONMENT,
        SURFGATE_PROVIDER_SESSION_ENCRYPTION_PREVIOUS_KEY: Buffer.from(
          'ed702e448be96c0072fbe2c7a860779ad50d112e840c5cc078ce5df319cf9885',
          'hex',
        ).toString('base64'),
      }),
    ).toThrowError(/SURFGATE_PROVIDER_SESSION_ENCRYPTION_PREVIOUS_KEY_ID/u)

    expect(() =>
      parseConfig({
        ...VALID_PRODUCTION_ENVIRONMENT,
        SURFGATE_RELAY_TOKEN_SIGNING_PREVIOUS_KEY: Buffer.from(
          'ee2764ce9bf12fa58d6efde476e987b2fafdd72fbbf6b1b93d774439b546ba72',
          'hex',
        ).toString('base64'),
        SURFGATE_RELAY_TOKEN_SIGNING_PREVIOUS_KEY_ID: 'relay-token-v1',
      }),
    ).toThrowError(/SURFGATE_RELAY_TOKEN_SIGNING_PREVIOUS_KEY_ID/u)

    expect(() =>
      parseConfig({
        ...VALID_PRODUCTION_ENVIRONMENT,
        SURFGATE_PROVIDER_SESSION_ENCRYPTION_PREVIOUS_KEY:
          VALID_PRODUCTION_ENVIRONMENT.SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY,
        SURFGATE_PROVIDER_SESSION_ENCRYPTION_PREVIOUS_KEY_ID: 'provider-old',
      }),
    ).toThrowError(/SURFGATE_PROVIDER_SESSION_ENCRYPTION_PREVIOUS_KEY/u)
  })

  it('keeps reconciliation outside every valid in-flight provider deadline', () => {
    expect(() =>
      parseConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        SURFGATE_PROVIDER_ALLOCATION_TIMEOUT_MS: '60000',
        SURFGATE_RECONCILIATION_STALE_AFTER_MS: '120000',
      }),
    ).toThrowError(/SURFGATE_RECONCILIATION_STALE_AFTER_MS/u)
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

  it.each([
    'postgresql://surfgate@database.surfgate.example/surfgate?sslmode=require',
    'postgresql://surfgate@database.surfgate.example/surfgate?sslmode=verify-full&sslmode=disable',
    'postgresql://surfgate@database.surfgate.example/surfgate?sslmode=verify-full&ssl=false',
    'postgresql://surfgate@database.surfgate.example/surfgate?sslmode=verify-full&uselibpqcompat=true',
    'postgresql://surfgate@database.surfgate.example/surfgate?sslmode=verify-full&host=%2Fvar%2Frun%2Fpostgresql',
    'postgresql://surfgate@database.surfgate.example/surfgate?sslmode=verify-full&host=127.0.0.1',
  ])('rejects ambiguous or downgraded production PostgreSQL TLS: %s', (databaseURL) => {
    expect(() =>
      parseConfig({ ...VALID_PRODUCTION_ENVIRONMENT, DATABASE_URL: databaseURL }),
    ).toThrowError(/DATABASE_URL/u)
  })

  it.each([
    'SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY_ID',
    'SURFGATE_RELAY_TOKEN_SIGNING_KEY_ID',
  ] as const)('requires explicit production key identity for %s', (key) => {
    expect(() => parseConfig({ ...VALID_PRODUCTION_ENVIRONMENT, [key]: undefined })).toThrowError(
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
    ['SURFGATE_OTEL_EXPORT_INTERVAL_MS', '99'],
    ['SURFGATE_OTEL_EXPORT_TIMEOUT_MS', '0'],
    ['SURFGATE_OTEL_SHUTDOWN_TIMEOUT_MS', '70000'],
    ['SURFGATE_OTEL_MAX_QUEUE_SIZE', '63'],
    ['SURFGATE_OTEL_MAX_EXPORT_BATCH_SIZE', '513'],
    ['SURFGATE_OTEL_METRIC_CARDINALITY_LIMIT', '4097'],
  ] as const)('rejects invalid telemetry setting %s', (key, value) => {
    expect(() => parseConfig({ ...VALID_DEVELOPMENT_ENVIRONMENT, [key]: value })).toThrowError(
      new RegExp(key),
    )
  })

  it('rejects a telemetry export interval shorter than its exporter timeout', () => {
    expect(() =>
      parseConfig({
        ...VALID_DEVELOPMENT_ENVIRONMENT,
        SURFGATE_OTEL_EXPORT_INTERVAL_MS: '100',
        SURFGATE_OTEL_EXPORT_TIMEOUT_MS: '5000',
      }),
    ).toThrowError(/SURFGATE_OTEL_EXPORT_INTERVAL_MS/u)
  })

  it.each([
    ['SURFGATE_TASK_MAX_ATTEMPTS', '0'],
    ['SURFGATE_TASK_EXECUTION_TIMEOUT_MS', '0'],
    ['SURFGATE_TASK_LEASE_TTL_MS', '44000'],
    ['SURFGATE_TASK_ARTIFACT_MAX_BYTES', '999999999'],
    ['SURFGATE_TASK_SCREENSHOT_MAX_PIXELS', '999'],
    ['SURFGATE_TASK_POLL_INTERVAL_MS', '0'],
  ] as const)('rejects invalid managed-task setting %s', (key, value) => {
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
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'https://user:secret@telemetry.example.test'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'https://telemetry.example.test?token=secret'],
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

  it.each(['host=production.example', 'port=6543', 'user=other', 'database=production'])(
    'rejects TEST_DATABASE_URL authority override parameter %s',
    (parameter) => {
      expect(() =>
        parseConfig({
          ...VALID_DEVELOPMENT_ENVIRONMENT,
          TEST_DATABASE_URL: `postgresql://surfgate@database.example/surfgate_test?${parameter}`,
        }),
      ).toThrowError(/TEST_DATABASE_URL/u)
    },
  )

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

  it('requires Cloudflare provider credentials in production', () => {
    const {
      CLOUDFLARE_ACCOUNT_ID: _accountID,
      CLOUDFLARE_BROWSER_RUN_API_TOKEN: _token,
      ...withoutProviderCredentials
    } = VALID_PRODUCTION_ENVIRONMENT

    expect(() => parseConfig(withoutProviderCredentials)).toThrowError(/CLOUDFLARE_ACCOUNT_ID/u)
    expect(_accountID).toBeDefined()
    expect(_token).toBeDefined()
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
