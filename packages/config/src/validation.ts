import { ConfigurationError, type ConfigurationIssue } from './configuration-error.js'
import type {
  CloudflareCredentials,
  DatabaseMigrationConfig,
  EnvironmentSource,
  LogLevel,
  ObjectStorageCredentials,
  ProviderSessionEncryptionConfig,
  ReconciliationConfig,
  RelayServiceConfig,
  RelayTokenSigningConfig,
  RuntimeEnvironment,
  SymmetricKeyConfig,
  SurfGateConfig,
  WorkerServiceConfig,
} from './types.js'

const RUNTIME_ENVIRONMENTS = ['development', 'test', 'production'] as const
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
const BASE64_32_BYTE_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/u
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const REQUIRED_DATABASE_MIGRATION = '0014-session-reconciliation-claim-index.sql'

function isLocalConfigurationHost(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/u, '')
  const normalized =
    normalizedHostname.startsWith('[') && normalizedHostname.endsWith(']')
      ? normalizedHostname.slice(1, -1)
      : normalizedHostname
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '::1' ||
    normalized === '::ffff:0:0' ||
    /^::ffff:7f[0-9a-f]{2}:/u.test(normalized) ||
    normalized.startsWith('127.')
  )
}

function rejectLocalProductionURL(
  url: URL | undefined,
  key: string,
  runtimeEnvironment: RuntimeEnvironment,
  issues: ConfigurationIssue[],
): void {
  if (
    runtimeEnvironment === 'production' &&
    url !== undefined &&
    isLocalConfigurationHost(url.hostname)
  ) {
    issues.push({ key, message: 'must not use a local development host in production' })
  }
}

function isObviousDevelopmentKey(key: Buffer): boolean {
  return key.every((byte) => byte === key[0])
}

function symmetricKey(
  environment: EnvironmentSource,
  keyName: string,
  keyIDName: string,
  options: Readonly<{
    required: boolean
    rejectDevelopmentKey: boolean
    requireExplicitID: boolean
  }>,
  issues: ConfigurationIssue[],
): SymmetricKeyConfig | undefined {
  const encodedKey = optionalSecret(environment, keyName)
  const configuredKeyID = optionalString(environment, keyIDName)
  if (encodedKey === undefined) {
    if (options.required) issues.push({ key: keyName, message: 'is required in production' })
    if (configuredKeyID !== undefined) {
      issues.push({ key: keyName, message: `is required when ${keyIDName} is set` })
    }
    return undefined
  }
  if (options.requireExplicitID && configuredKeyID === undefined) {
    issues.push({ key: keyIDName, message: `is required when ${keyName} is set` })
  }
  if (!BASE64_32_BYTE_KEY_PATTERN.test(encodedKey)) {
    issues.push({ key: keyName, message: 'must be a base64-encoded 32-byte key' })
    return undefined
  }
  const decodedKey = Buffer.from(encodedKey, 'base64')
  if (decodedKey.byteLength !== 32 || decodedKey.toString('base64') !== encodedKey) {
    issues.push({ key: keyName, message: 'must be a base64-encoded 32-byte key' })
    return undefined
  }
  if (options.rejectDevelopmentKey && isObviousDevelopmentKey(decodedKey)) {
    issues.push({ key: keyName, message: 'must not use obvious development key material' })
    return undefined
  }
  const keyID = configuredKeyID ?? 'v1'
  if (!KEY_ID_PATTERN.test(keyID)) {
    issues.push({ key: keyIDName, message: 'must be a safe key identifier' })
    return undefined
  }
  return Object.freeze({ key: createSecretKey(decodedKey), keyID })
}

function previousSymmetricKey(
  environment: EnvironmentSource,
  keyName: string,
  keyIDName: string,
  current: SymmetricKeyConfig | undefined,
  runtimeEnvironment: RuntimeEnvironment,
  issues: ConfigurationIssue[],
): readonly SymmetricKeyConfig[] {
  const previous = symmetricKey(
    environment,
    keyName,
    keyIDName,
    {
      required: false,
      rejectDevelopmentKey: runtimeEnvironment === 'production',
      requireExplicitID: true,
    },
    issues,
  )
  if (previous === undefined) return Object.freeze([])
  if (current?.keyID === previous.keyID) {
    issues.push({ key: keyIDName, message: 'must differ from the current key identifier' })
    return Object.freeze([])
  }
  if (
    current !== undefined &&
    Buffer.from(current.key.export()).equals(Buffer.from(previous.key.export()))
  ) {
    issues.push({ key: keyName, message: 'must differ from the current key material' })
    return Object.freeze([])
  }
  return Object.freeze([previous])
}

function optionalString(environment: EnvironmentSource, key: string): string | undefined {
  const value = environment[key]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

function optionalSecret(environment: EnvironmentSource, key: string): string | undefined {
  const value = environment[key]
  return value === undefined || value.trim().length === 0 ? undefined : value
}

function requiredString(
  environment: EnvironmentSource,
  key: string,
  issues: ConfigurationIssue[],
): string {
  const value = optionalString(environment, key)
  if (value === undefined) {
    issues.push({ key, message: 'is required' })
    return ''
  }
  return value
}

function choice<const Choice extends string>(
  environment: EnvironmentSource,
  key: string,
  choices: readonly Choice[],
  defaultValue: Choice,
  issues: ConfigurationIssue[],
): Choice {
  const value = optionalString(environment, key)
  if (value === undefined) {
    return defaultValue
  }
  if ((choices as readonly string[]).includes(value)) {
    return value as Choice
  }
  issues.push({ key, message: 'has an unsupported value' })
  return defaultValue
}

function port(
  environment: EnvironmentSource,
  key: string,
  defaultValue: number,
  issues: ConfigurationIssue[],
): number {
  const value = optionalString(environment, key)
  if (value === undefined) {
    return defaultValue
  }
  if (!/^\d+$/u.test(value)) {
    issues.push({ key, message: 'must be an integer from 1 through 65535' })
    return defaultValue
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    issues.push({ key, message: 'must be an integer from 1 through 65535' })
    return defaultValue
  }
  return parsed
}

function boundedInteger(
  environment: EnvironmentSource,
  key: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
  issues: ConfigurationIssue[],
): number {
  const value = optionalString(environment, key)
  if (value === undefined) return defaultValue
  if (!/^\d+$/u.test(value)) {
    issues.push({ key, message: `must be an integer from ${minimum} through ${maximum}` })
    return defaultValue
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    issues.push({ key, message: `must be an integer from ${minimum} through ${maximum}` })
    return defaultValue
  }
  return parsed
}

function parsedURL(
  rawValue: string,
  key: string,
  protocols: readonly string[],
  fallback: URL,
  issues: ConfigurationIssue[],
): URL {
  try {
    const value = new URL(rawValue)
    if (!protocols.includes(value.protocol) || value.hostname.length === 0) {
      throw new TypeError('Unsupported URL')
    }
    return value
  } catch {
    issues.push({ key, message: 'must be a valid URL with a supported protocol' })
    return fallback
  }
}

function requiredURL(
  environment: EnvironmentSource,
  key: string,
  protocols: readonly string[],
  fallback: URL,
  issues: ConfigurationIssue[],
): URL {
  const value = requiredString(environment, key, issues)
  return value.length === 0 ? fallback : parsedURL(value, key, protocols, fallback, issues)
}

function optionalURL(
  environment: EnvironmentSource,
  key: string,
  protocols: readonly string[],
  fallback: URL,
  issues: ConfigurationIssue[],
): URL | undefined {
  const value = optionalString(environment, key)
  return value === undefined ? undefined : parsedURL(value, key, protocols, fallback, issues)
}

function telemetryEndpoint(
  environment: EnvironmentSource,
  secureTransportRequired: boolean,
  issues: ConfigurationIssue[],
): URL | undefined {
  const key = 'OTEL_EXPORTER_OTLP_ENDPOINT'
  const endpoint = optionalURL(
    environment,
    key,
    secureTransportRequired ? ['https:'] : ['http:', 'https:'],
    new URL('https://invalid.invalid'),
    issues,
  )
  if (
    endpoint !== undefined &&
    (endpoint.username.length > 0 ||
      endpoint.password.length > 0 ||
      endpoint.search.length > 0 ||
      endpoint.hash.length > 0)
  ) {
    issues.push({ key, message: 'must not contain credentials, query parameters, or a fragment' })
  }
  return endpoint
}

function relayPublicURL(
  environment: EnvironmentSource,
  secureTransportRequired: boolean,
  issues: ConfigurationIssue[],
): URL {
  const key = 'SURFGATE_RELAY_PUBLIC_URL'
  const value = requiredURL(
    environment,
    key,
    secureTransportRequired ? ['wss:'] : ['ws:', 'wss:'],
    new URL('ws://invalid.invalid'),
    issues,
  )
  if (
    value.username.length > 0 ||
    value.password.length > 0 ||
    value.search.length > 0 ||
    value.hash.length > 0 ||
    value.pathname !== '/'
  ) {
    issues.push({ key, message: 'must be a credential-free relay origin URL' })
  }
  return value
}

function objectStorageCredentials(
  environment: EnvironmentSource,
  issues: ConfigurationIssue[],
): ObjectStorageCredentials | undefined {
  const accessKeyID = optionalString(environment, 'S3_ACCESS_KEY_ID')
  const secretAccessKey = optionalSecret(environment, 'S3_SECRET_ACCESS_KEY')
  if (accessKeyID === undefined && secretAccessKey === undefined) {
    return undefined
  }
  if (accessKeyID === undefined) {
    issues.push({ key: 'S3_ACCESS_KEY_ID', message: 'is required when S3 credentials are set' })
  }
  if (secretAccessKey === undefined) {
    issues.push({ key: 'S3_SECRET_ACCESS_KEY', message: 'is required when S3 credentials are set' })
  }
  if (accessKeyID === undefined || secretAccessKey === undefined) {
    return undefined
  }
  return Object.freeze({ accessKeyID, secretAccessKey })
}

function cloudflareCredentials(
  environment: EnvironmentSource,
  runtimeEnvironment: RuntimeEnvironment,
  issues: ConfigurationIssue[],
): CloudflareCredentials | undefined {
  const accountID = optionalString(environment, 'CLOUDFLARE_ACCOUNT_ID')
  const browserRunAPIToken = optionalSecret(environment, 'CLOUDFLARE_BROWSER_RUN_API_TOKEN')
  if (accountID === undefined && browserRunAPIToken === undefined) {
    if (runtimeEnvironment === 'production') {
      issues.push({ key: 'CLOUDFLARE_ACCOUNT_ID', message: 'is required in production' })
      issues.push({
        key: 'CLOUDFLARE_BROWSER_RUN_API_TOKEN',
        message: 'is required in production',
      })
    }
    return undefined
  }
  if (accountID === undefined) {
    issues.push({
      key: 'CLOUDFLARE_ACCOUNT_ID',
      message: 'is required when Cloudflare credentials are set',
    })
  }
  if (accountID !== undefined && !/^[0-9a-f]{32}$/u.test(accountID)) {
    issues.push({
      key: 'CLOUDFLARE_ACCOUNT_ID',
      message: 'must be a 32-character lowercase hexadecimal account ID',
    })
  }
  if (browserRunAPIToken === undefined) {
    issues.push({
      key: 'CLOUDFLARE_BROWSER_RUN_API_TOKEN',
      message: 'is required when Cloudflare credentials are set',
    })
  }
  if (
    accountID === undefined ||
    browserRunAPIToken === undefined ||
    !/^[0-9a-f]{32}$/u.test(accountID)
  ) {
    return undefined
  }
  return Object.freeze({ accountID, browserRunAPIToken })
}

function cloudflareAPIBaseURL(environment: EnvironmentSource, issues: ConfigurationIssue[]): URL {
  const key = 'CLOUDFLARE_API_BASE_URL'
  const rawValue = optionalString(environment, key) ?? 'https://api.cloudflare.com/client/v4'
  try {
    const value = new URL(rawValue)
    if (
      value.protocol !== 'https:' ||
      value.hostname !== 'api.cloudflare.com' ||
      value.port.length > 0 ||
      value.username.length > 0 ||
      value.password.length > 0 ||
      value.pathname.replace(/\/+$/u, '') !== '/client/v4' ||
      value.search.length > 0 ||
      value.hash.length > 0
    ) {
      throw new TypeError('Unsupported Cloudflare API base URL')
    }
    return value
  } catch {
    issues.push({ key, message: 'must be the secure Cloudflare API v4 base URL' })
    return new URL('https://api.cloudflare.com/client/v4')
  }
}

function providerSessionEncryption(
  environment: EnvironmentSource,
  runtimeEnvironment: RuntimeEnvironment,
  issues: ConfigurationIssue[],
): ProviderSessionEncryptionConfig | undefined {
  const current = symmetricKey(
    environment,
    'SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY',
    'SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY_ID',
    {
      required: runtimeEnvironment === 'production',
      rejectDevelopmentKey: runtimeEnvironment === 'production',
      requireExplicitID: runtimeEnvironment === 'production',
    },
    issues,
  )
  const decryptionKeys = previousSymmetricKey(
    environment,
    'SURFGATE_PROVIDER_SESSION_ENCRYPTION_PREVIOUS_KEY',
    'SURFGATE_PROVIDER_SESSION_ENCRYPTION_PREVIOUS_KEY_ID',
    current,
    runtimeEnvironment,
    issues,
  )
  return current === undefined ? undefined : Object.freeze({ ...current, decryptionKeys })
}

function relayTokenSigning(
  environment: EnvironmentSource,
  runtimeEnvironment: RuntimeEnvironment,
  issues: ConfigurationIssue[],
  requiredInProduction = true,
): RelayTokenSigningConfig | undefined {
  const current = symmetricKey(
    environment,
    'SURFGATE_RELAY_TOKEN_SIGNING_KEY',
    'SURFGATE_RELAY_TOKEN_SIGNING_KEY_ID',
    {
      required: requiredInProduction && runtimeEnvironment === 'production',
      rejectDevelopmentKey: runtimeEnvironment === 'production',
      requireExplicitID: runtimeEnvironment === 'production',
    },
    issues,
  )
  const verificationKeys = previousSymmetricKey(
    environment,
    'SURFGATE_RELAY_TOKEN_SIGNING_PREVIOUS_KEY',
    'SURFGATE_RELAY_TOKEN_SIGNING_PREVIOUS_KEY_ID',
    current,
    runtimeEnvironment,
    issues,
  )
  return current === undefined ? undefined : Object.freeze({ ...current, verificationKeys })
}

function requireProductionPostgresTLS(
  url: URL,
  environment: RuntimeEnvironment,
  issues: ConfigurationIssue[],
): void {
  if (environment !== 'production') return
  const sslModes = url.searchParams.getAll('sslmode')
  const ambiguousTLSParameters =
    url.searchParams.has('ssl') || url.searchParams.has('uselibpqcompat')
  if (sslModes.length !== 1 || sslModes[0] !== 'verify-full' || ambiguousTLSParameters) {
    issues.push({
      key: 'DATABASE_URL',
      message: 'must use one unambiguous sslmode=verify-full in production',
    })
  }
}

function rejectPostgresAuthorityOverrides(
  url: URL,
  key: 'DATABASE_URL' | 'TEST_DATABASE_URL',
  issues: ConfigurationIssue[],
): void {
  const authorityOverride = ['host', 'port', 'user', 'password', 'database', 'dbname'].some(
    (parameter) => url.searchParams.has(parameter),
  )
  if (authorityOverride) {
    issues.push({
      key,
      message: 'must define connection authority only in the URL authority component',
    })
  }
}

export function parseDatabaseMigrationConfig(
  environment: EnvironmentSource,
): DatabaseMigrationConfig {
  const issues: ConfigurationIssue[] = []
  const runtimeEnvironment = choice(
    environment,
    'NODE_ENV',
    RUNTIME_ENVIRONMENTS,
    'development',
    issues,
  ) satisfies RuntimeEnvironment
  const databaseURL = requiredURL(
    environment,
    'DATABASE_URL',
    ['postgres:', 'postgresql:'],
    new URL('postgresql://invalid.invalid/surfgate'),
    issues,
  )
  rejectPostgresAuthorityOverrides(databaseURL, 'DATABASE_URL', issues)
  requireProductionPostgresTLS(databaseURL, runtimeEnvironment, issues)
  rejectLocalProductionURL(databaseURL, 'DATABASE_URL', runtimeEnvironment, issues)
  const testDatabaseURL = optionalURL(
    environment,
    'TEST_DATABASE_URL',
    ['postgres:', 'postgresql:'],
    new URL('postgresql://invalid.invalid/surfgate_test'),
    issues,
  )
  if (testDatabaseURL !== undefined) {
    rejectPostgresAuthorityOverrides(testDatabaseURL, 'TEST_DATABASE_URL', issues)
  }
  if (issues.length > 0) throw new ConfigurationError(issues)
  return Object.freeze({
    database: Object.freeze({
      url: databaseURL,
      testURL: testDatabaseURL,
      requiredMigration: REQUIRED_DATABASE_MIGRATION,
    }),
  })
}

function parseSurfGateConfig(
  sourceEnvironment: EnvironmentSource,
  scope: 'full' | 'reconciler' | 'relay' | 'worker',
): SurfGateConfig {
  const withoutObjectStorage = scope === 'reconciler' || scope === 'relay'
  const withoutRelayDependencies = scope === 'reconciler' || scope === 'worker'
  const environment: EnvironmentSource =
    scope === 'full'
      ? sourceEnvironment
      : {
          ...sourceEnvironment,
          ...(withoutObjectStorage
            ? {
                AWS_ACCESS_KEY_ID: undefined,
                AWS_SECRET_ACCESS_KEY: undefined,
                S3_BUCKET: 'unused-component',
                S3_ENDPOINT: 'https://unused.invalid',
                S3_REGION: 'unused',
                S3_ACCESS_KEY_ID: undefined,
                S3_SECRET_ACCESS_KEY: undefined,
              }
            : {}),
          ...(withoutRelayDependencies
            ? {
                REDIS_URL: 'rediss://unused.invalid',
                SURFGATE_RELAY_PUBLIC_URL: 'wss://unused.invalid',
                SURFGATE_RELAY_TOKEN_SIGNING_KEY: undefined,
                SURFGATE_RELAY_TOKEN_SIGNING_KEY_ID: undefined,
                SURFGATE_RELAY_TOKEN_SIGNING_PREVIOUS_KEY: undefined,
                SURFGATE_RELAY_TOKEN_SIGNING_PREVIOUS_KEY_ID: undefined,
              }
            : {}),
        }
  const issues: ConfigurationIssue[] = []
  const runtime = Object.freeze({
    environment: choice(
      environment,
      'NODE_ENV',
      RUNTIME_ENVIRONMENTS,
      'development',
      issues,
    ) satisfies RuntimeEnvironment,
    logLevel: choice(environment, 'LOG_LEVEL', LOG_LEVELS, 'info', issues) satisfies LogLevel,
  })
  const api = Object.freeze({
    host: optionalString(environment, 'SURFGATE_API_HOST') ?? '127.0.0.1',
    port: port(environment, 'SURFGATE_API_PORT', 8080, issues),
  })
  const secureTransportRequired = runtime.environment === 'production'
  const relay = Object.freeze({
    host: optionalString(environment, 'SURFGATE_RELAY_HOST') ?? '127.0.0.1',
    port: port(environment, 'SURFGATE_RELAY_PORT', 8081, issues),
    publicURL: relayPublicURL(environment, secureTransportRequired, issues),
    tokenTTLSeconds: boundedInteger(
      environment,
      'SURFGATE_RELAY_TOKEN_TTL_SECONDS',
      60,
      10,
      300,
      issues,
    ),
    connectTimeoutMs: boundedInteger(
      environment,
      'SURFGATE_RELAY_CONNECT_TIMEOUT_MS',
      10_000,
      100,
      60_000,
      issues,
    ),
    idleTimeoutMs: boundedInteger(
      environment,
      'SURFGATE_RELAY_IDLE_TIMEOUT_MS',
      60_000,
      1_000,
      3_600_000,
      issues,
    ),
    absoluteTimeoutMs: boundedInteger(
      environment,
      'SURFGATE_RELAY_ABSOLUTE_TIMEOUT_MS',
      3_600_000,
      1_000,
      86_400_000,
      issues,
    ),
    maxMessageBytes: boundedInteger(
      environment,
      'SURFGATE_RELAY_MAX_MESSAGE_BYTES',
      8 * 1_024 * 1_024,
      1_024,
      64 * 1_024 * 1_024,
      issues,
    ),
    maxQueuedBytes: boundedInteger(
      environment,
      'SURFGATE_RELAY_MAX_QUEUED_BYTES',
      16 * 1_024 * 1_024,
      1_024,
      128 * 1_024 * 1_024,
      issues,
    ),
    leaseTTLms: boundedInteger(
      environment,
      'SURFGATE_RELAY_LEASE_TTL_MS',
      15_000,
      1_000,
      60_000,
      issues,
    ),
    authorizationCheckIntervalMs: boundedInteger(
      environment,
      'SURFGATE_RELAY_AUTHORIZATION_CHECK_INTERVAL_MS',
      2_000,
      250,
      60_000,
      issues,
    ),
    drainTimeoutMs: boundedInteger(
      environment,
      'SURFGATE_RELAY_DRAIN_TIMEOUT_MS',
      10_000,
      100,
      60_000,
      issues,
    ),
  })
  if (relay.maxQueuedBytes < relay.maxMessageBytes) {
    issues.push({
      key: 'SURFGATE_RELAY_MAX_QUEUED_BYTES',
      message: 'must be greater than or equal to the maximum message size',
    })
  }
  const databaseURL = requiredURL(
    environment,
    'DATABASE_URL',
    ['postgres:', 'postgresql:'],
    new URL('postgresql://invalid.invalid/surfgate'),
    issues,
  )
  rejectPostgresAuthorityOverrides(databaseURL, 'DATABASE_URL', issues)
  requireProductionPostgresTLS(databaseURL, runtime.environment, issues)
  rejectLocalProductionURL(databaseURL, 'DATABASE_URL', runtime.environment, issues)
  const testDatabaseURL = optionalURL(
    environment,
    'TEST_DATABASE_URL',
    ['postgres:', 'postgresql:'],
    new URL('postgresql://invalid.invalid/surfgate_test'),
    issues,
  )
  if (testDatabaseURL !== undefined) {
    rejectPostgresAuthorityOverrides(testDatabaseURL, 'TEST_DATABASE_URL', issues)
  }
  const database = Object.freeze({
    url: databaseURL,
    requiredMigration: REQUIRED_DATABASE_MIGRATION,
    testURL: testDatabaseURL,
  })
  const redis = Object.freeze({
    url: requiredURL(
      environment,
      'REDIS_URL',
      secureTransportRequired ? ['rediss:'] : ['redis:', 'rediss:'],
      new URL('redis://invalid.invalid'),
      issues,
    ),
  })
  rejectLocalProductionURL(redis.url, 'REDIS_URL', runtime.environment, issues)
  const objectStorage = Object.freeze({
    region: requiredString(environment, 'S3_REGION', issues),
    bucket: requiredString(environment, 'S3_BUCKET', issues),
    endpoint: optionalURL(
      environment,
      'S3_ENDPOINT',
      secureTransportRequired ? ['https:'] : ['http:', 'https:'],
      new URL('https://invalid.invalid'),
      issues,
    ),
    credentials: objectStorageCredentials(environment, issues),
  })
  rejectLocalProductionURL(objectStorage.endpoint, 'S3_ENDPOINT', runtime.environment, issues)
  const telemetry = Object.freeze({
    serviceName: optionalString(environment, 'OTEL_SERVICE_NAME') ?? 'surfgate',
    endpoint: telemetryEndpoint(environment, secureTransportRequired, issues),
    exportIntervalMs: boundedInteger(
      environment,
      'SURFGATE_OTEL_EXPORT_INTERVAL_MS',
      10_000,
      100,
      300_000,
      issues,
    ),
    exportTimeoutMs: boundedInteger(
      environment,
      'SURFGATE_OTEL_EXPORT_TIMEOUT_MS',
      5_000,
      100,
      60_000,
      issues,
    ),
    shutdownTimeoutMs: boundedInteger(
      environment,
      'SURFGATE_OTEL_SHUTDOWN_TIMEOUT_MS',
      5_000,
      100,
      60_000,
      issues,
    ),
    maxQueueSize: boundedInteger(
      environment,
      'SURFGATE_OTEL_MAX_QUEUE_SIZE',
      2_048,
      64,
      65_536,
      issues,
    ),
    maxExportBatchSize: boundedInteger(
      environment,
      'SURFGATE_OTEL_MAX_EXPORT_BATCH_SIZE',
      512,
      16,
      512,
      issues,
    ),
    metricCardinalityLimit: boundedInteger(
      environment,
      'SURFGATE_OTEL_METRIC_CARDINALITY_LIMIT',
      128,
      16,
      4_096,
      issues,
    ),
  })
  rejectLocalProductionURL(
    telemetry.endpoint,
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    runtime.environment,
    issues,
  )
  if (telemetry.maxExportBatchSize > telemetry.maxQueueSize) {
    issues.push({
      key: 'SURFGATE_OTEL_MAX_EXPORT_BATCH_SIZE',
      message: 'must be less than or equal to the telemetry queue size',
    })
  }
  if (telemetry.exportIntervalMs < telemetry.exportTimeoutMs) {
    issues.push({
      key: 'SURFGATE_OTEL_EXPORT_INTERVAL_MS',
      message: 'must be greater than or equal to the telemetry export timeout',
    })
  }
  const cloudflare = Object.freeze({
    apiBaseURL: cloudflareAPIBaseURL(environment, issues),
    credentials: cloudflareCredentials(environment, runtime.environment, issues),
  })
  const security = Object.freeze({
    providerSessionEncryption: providerSessionEncryption(environment, runtime.environment, issues),
    relayTokenSigning: relayTokenSigning(
      environment,
      runtime.environment,
      issues,
      scope === 'full' || scope === 'relay',
    ),
    rawCDPAccess: choice(
      environment,
      'SURFGATE_RAW_CDP_ACCESS',
      ['disabled', 'trusted'] as const,
      runtime.environment === 'production' ? 'disabled' : 'trusted',
      issues,
    ),
  })
  if (
    runtime.environment === 'production' &&
    security.providerSessionEncryption !== undefined &&
    security.relayTokenSigning !== undefined
  ) {
    const encryptionKeys = [
      security.providerSessionEncryption,
      ...security.providerSessionEncryption.decryptionKeys,
    ]
    const signingKeys = [security.relayTokenSigning, ...security.relayTokenSigning.verificationKeys]
    const reusesKeyMaterial = encryptionKeys.some((encryptionKey) =>
      signingKeys.some((signingKey) =>
        Buffer.from(encryptionKey.key.export()).equals(Buffer.from(signingKey.key.export())),
      ),
    )
    if (reusesKeyMaterial) {
      issues.push({
        key: 'SURFGATE_RELAY_TOKEN_SIGNING_KEY',
        message: 'must be independent from all provider-session encryption material',
      })
    }
  }
  const controlPlane = Object.freeze({
    healthTimeoutMs: boundedInteger(
      environment,
      'SURFGATE_PROVIDER_HEALTH_TIMEOUT_MS',
      5_000,
      100,
      60_000,
      issues,
    ),
    allocationTimeoutMs: boundedInteger(
      environment,
      'SURFGATE_PROVIDER_ALLOCATION_TIMEOUT_MS',
      30_000,
      100,
      600_000,
      issues,
    ),
    terminationTimeoutMs: boundedInteger(
      environment,
      'SURFGATE_PROVIDER_TERMINATION_TIMEOUT_MS',
      15_000,
      100,
      600_000,
      issues,
    ),
    idempotencyWaitTimeoutMs: boundedInteger(
      environment,
      'SURFGATE_IDEMPOTENCY_WAIT_TIMEOUT_MS',
      35_000,
      100,
      600_000,
      issues,
    ),
    reconciliationStaleAfterMs: boundedInteger(
      environment,
      'SURFGATE_RECONCILIATION_STALE_AFTER_MS',
      120_000,
      30_000,
      86_400_000,
      issues,
    ),
    reconciliationBatchSize: boundedInteger(
      environment,
      'SURFGATE_RECONCILIATION_BATCH_SIZE',
      100,
      1,
      1_000,
      issues,
    ),
    quotas: Object.freeze({
      requestsPerMinute: boundedInteger(
        environment,
        'SURFGATE_QUOTA_REQUESTS_PER_MINUTE',
        60,
        1,
        100_000,
        issues,
      ),
      maxConcurrentSessions: boundedInteger(
        environment,
        'SURFGATE_QUOTA_MAX_CONCURRENT_SESSIONS',
        10,
        1,
        10_000,
        issues,
      ),
      maxSessionDurationSeconds: boundedInteger(
        environment,
        'SURFGATE_QUOTA_MAX_SESSION_DURATION_SECONDS',
        600,
        1,
        86_400,
        issues,
      ),
    }),
  })
  const minimumReconciliationStaleAfterMs =
    Math.max(
      controlPlane.healthTimeoutMs * 2 + controlPlane.allocationTimeoutMs * 2,
      controlPlane.terminationTimeoutMs,
    ) + 30_000
  if (controlPlane.reconciliationStaleAfterMs < minimumReconciliationStaleAfterMs) {
    issues.push({
      key: 'SURFGATE_RECONCILIATION_STALE_AFTER_MS',
      message: `must be at least ${minimumReconciliationStaleAfterMs} milliseconds for configured provider deadlines`,
    })
  }
  const tasks = Object.freeze({
    requestsPerMinute: boundedInteger(
      environment,
      'SURFGATE_TASK_REQUESTS_PER_MINUTE',
      120,
      1,
      100_000,
      issues,
    ),
    maxQueuedPerTenant: boundedInteger(
      environment,
      'SURFGATE_TASK_MAX_QUEUED_PER_TENANT',
      100,
      1,
      100_000,
      issues,
    ),
    maxRunningPerTenant: boundedInteger(
      environment,
      'SURFGATE_TASK_MAX_RUNNING_PER_TENANT',
      5,
      1,
      1_000,
      issues,
    ),
    maxAttempts: boundedInteger(environment, 'SURFGATE_TASK_MAX_ATTEMPTS', 3, 1, 10, issues),
    executionTimeoutMs: boundedInteger(
      environment,
      'SURFGATE_TASK_EXECUTION_TIMEOUT_MS',
      30_000,
      100,
      600_000,
      issues,
    ),
    leaseTTLms: boundedInteger(
      environment,
      'SURFGATE_TASK_LEASE_TTL_MS',
      60_000,
      1_000,
      900_000,
      issues,
    ),
    pollIntervalMs: boundedInteger(
      environment,
      'SURFGATE_TASK_POLL_INTERVAL_MS',
      250,
      10,
      60_000,
      issues,
    ),
    extractMaxBytes: boundedInteger(
      environment,
      'SURFGATE_TASK_EXTRACT_MAX_BYTES',
      1_048_576,
      1_024,
      16_777_216,
      issues,
    ),
    artifactMaxBytes: boundedInteger(
      environment,
      'SURFGATE_TASK_ARTIFACT_MAX_BYTES',
      16_777_216,
      1_024,
      67_108_864,
      issues,
    ),
    screenshotMaxPixels: boundedInteger(
      environment,
      'SURFGATE_TASK_SCREENSHOT_MAX_PIXELS',
      33_554_432,
      1_000_000,
      67_108_864,
      issues,
    ),
    artifactRetentionSeconds: boundedInteger(
      environment,
      'SURFGATE_TASK_ARTIFACT_RETENTION_SECONDS',
      86_400,
      60,
      31_536_000,
      issues,
    ),
  })
  if (tasks.leaseTTLms < tasks.executionTimeoutMs + 15_000) {
    issues.push({
      key: 'SURFGATE_TASK_LEASE_TTL_MS',
      message: 'must exceed the task execution timeout by at least 15000 milliseconds',
    })
  }
  const worker = Object.freeze({
    healthHost: optionalString(environment, 'SURFGATE_WORKER_HEALTH_HOST') ?? '127.0.0.1',
    healthPort: port(environment, 'SURFGATE_WORKER_HEALTH_PORT', 8082, issues),
    readinessTimeoutMs: boundedInteger(
      environment,
      'SURFGATE_WORKER_READINESS_TIMEOUT_MS',
      5_000,
      100,
      60_000,
      issues,
    ),
    drainTimeoutMs: boundedInteger(
      environment,
      'SURFGATE_WORKER_DRAIN_TIMEOUT_MS',
      10_000,
      100,
      120_000,
      issues,
    ),
  })

  if (issues.length > 0) {
    throw new ConfigurationError(issues)
  }

  return Object.freeze({
    runtime,
    api,
    relay,
    database,
    redis,
    objectStorage,
    tasks,
    worker,
    telemetry,
    cloudflare,
    security,
    controlPlane,
  })
}

export function parseConfig(environment: EnvironmentSource): SurfGateConfig {
  return parseSurfGateConfig(environment, 'full')
}

export function parseReconciliationConfig(environment: EnvironmentSource): ReconciliationConfig {
  const config = parseSurfGateConfig(environment, 'reconciler')
  return Object.freeze({
    cloudflare: config.cloudflare,
    controlPlane: config.controlPlane,
    database: config.database,
    runtime: config.runtime,
    security: config.security,
    telemetry: config.telemetry,
  })
}

export function parseRelayConfig(environment: EnvironmentSource): RelayServiceConfig {
  const config = parseSurfGateConfig(environment, 'relay')
  return Object.freeze({
    cloudflare: config.cloudflare,
    database: config.database,
    redis: config.redis,
    relay: config.relay,
    runtime: config.runtime,
    security: config.security,
    telemetry: config.telemetry,
  })
}

export function parseWorkerConfig(environment: EnvironmentSource): WorkerServiceConfig {
  const config = parseSurfGateConfig(environment, 'worker')
  return Object.freeze({
    cloudflare: config.cloudflare,
    database: config.database,
    objectStorage: config.objectStorage,
    runtime: config.runtime,
    security: config.security,
    tasks: config.tasks,
    telemetry: config.telemetry,
    worker: config.worker,
  })
}
import { createSecretKey } from 'node:crypto'
