import { ConfigurationError, type ConfigurationIssue } from './configuration-error.js'
import type {
  CloudflareCredentials,
  EnvironmentSource,
  LogLevel,
  ObjectStorageCredentials,
  RuntimeEnvironment,
  ProviderSessionEncryptionConfig,
  SurfGateConfig,
} from './types.js'

const RUNTIME_ENVIRONMENTS = ['development', 'test', 'production'] as const
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
const POSTGRES_TLS_MODES = ['require', 'verify-ca', 'verify-full'] as const
const BASE64_32_BYTE_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/u
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

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
  issues: ConfigurationIssue[],
): CloudflareCredentials | undefined {
  const accountID = optionalString(environment, 'CLOUDFLARE_ACCOUNT_ID')
  const browserRunAPIToken = optionalSecret(environment, 'CLOUDFLARE_BROWSER_RUN_API_TOKEN')
  if (accountID === undefined && browserRunAPIToken === undefined) {
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
  const keyName = 'SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY'
  const encodedKey = optionalSecret(environment, keyName)
  if (encodedKey === undefined) {
    if (runtimeEnvironment === 'production') {
      issues.push({ key: keyName, message: 'is required in production' })
    }
    return undefined
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

  const keyID = optionalString(environment, 'SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY_ID') ?? 'v1'
  if (!KEY_ID_PATTERN.test(keyID)) {
    issues.push({
      key: 'SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY_ID',
      message: 'must be a safe key identifier',
    })
    return undefined
  }

  return Object.freeze({ key: createSecretKey(decodedKey), keyID })
}

function requireProductionPostgresTLS(
  url: URL,
  environment: RuntimeEnvironment,
  issues: ConfigurationIssue[],
): void {
  if (
    environment === 'production' &&
    !(POSTGRES_TLS_MODES as readonly string[]).includes(url.searchParams.get('sslmode') ?? '')
  ) {
    issues.push({ key: 'DATABASE_URL', message: 'must require TLS in production' })
  }
}

export function parseConfig(environment: EnvironmentSource): SurfGateConfig {
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
    publicURL: requiredURL(
      environment,
      'SURFGATE_RELAY_PUBLIC_URL',
      secureTransportRequired ? ['wss:'] : ['ws:', 'wss:'],
      new URL('ws://invalid.invalid'),
      issues,
    ),
  })
  const databaseURL = requiredURL(
    environment,
    'DATABASE_URL',
    ['postgres:', 'postgresql:'],
    new URL('postgresql://invalid.invalid/surfgate'),
    issues,
  )
  requireProductionPostgresTLS(databaseURL, runtime.environment, issues)
  const database = Object.freeze({
    url: databaseURL,
    testURL: optionalURL(
      environment,
      'TEST_DATABASE_URL',
      ['postgres:', 'postgresql:'],
      new URL('postgresql://invalid.invalid/surfgate_test'),
      issues,
    ),
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
  const telemetry = Object.freeze({
    serviceName: optionalString(environment, 'OTEL_SERVICE_NAME') ?? 'surfgate',
    endpoint: optionalURL(
      environment,
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      secureTransportRequired ? ['https:'] : ['http:', 'https:'],
      new URL('https://invalid.invalid'),
      issues,
    ),
  })
  const cloudflare = Object.freeze({
    apiBaseURL: cloudflareAPIBaseURL(environment, issues),
    credentials: cloudflareCredentials(environment, issues),
  })
  const security = Object.freeze({
    providerSessionEncryption: providerSessionEncryption(environment, runtime.environment, issues),
  })
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
    telemetry,
    cloudflare,
    security,
    controlPlane,
  })
}
import { createSecretKey } from 'node:crypto'
