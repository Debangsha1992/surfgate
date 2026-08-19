import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  loadConfig,
  loadDatabaseMigrationConfig,
  loadReconciliationConfig,
  loadRelayConfig,
  loadWorkerConfig,
} from '../src/index.js'

const temporaryDirectories: string[] = []

function createDotEnv(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'surfgate-config-'))
  temporaryDirectories.push(directory)
  const path = join(directory, '.env')
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 })
  return path
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

const DOT_ENV = `
NODE_ENV=development
LOG_LEVEL=info
SURFGATE_API_HOST=127.0.0.1
SURFGATE_API_PORT=8080
SURFGATE_RELAY_HOST=127.0.0.1
SURFGATE_RELAY_PORT=8081
SURFGATE_RELAY_PUBLIC_URL=ws://127.0.0.1:8081
DATABASE_URL=postgresql://surfgate:surfgate@127.0.0.1:5432/surfgate
REDIS_URL=redis://127.0.0.1:6379
S3_REGION=auto
S3_BUCKET=surfgate-dev
OTEL_SERVICE_NAME=surfgate
`

describe('loadConfig', () => {
  it('loads local development values from an explicit .env file', () => {
    const dotEnvPath = createDotEnv(DOT_ENV)

    const config = loadConfig({ dotEnvPath, env: {} })

    expect(config.runtime.environment).toBe('development')
    expect(config.database.url.hostname).toBe('127.0.0.1')
  })

  it('lets process environment values override local .env values', () => {
    const dotEnvPath = createDotEnv(DOT_ENV)

    const config = loadConfig({
      dotEnvPath,
      env: { LOG_LEVEL: 'debug', SURFGATE_API_PORT: '9090' },
    })

    expect(config.runtime.logLevel).toBe('debug')
    expect(config.api.port).toBe(9090)
  })

  it('uses only the process environment in production', () => {
    const dotEnvPath = createDotEnv(DOT_ENV)

    expect(() =>
      loadConfig({
        dotEnvPath,
        env: { NODE_ENV: 'production' },
      }),
    ).toThrowError(/DATABASE_URL/u)
  })

  it('does not let .env promote the runtime into production', () => {
    const dotEnvPath = createDotEnv(DOT_ENV.replace('NODE_ENV=development', 'NODE_ENV=production'))

    const config = loadConfig({ dotEnvPath, env: {} })

    expect(config.runtime.environment).toBe('development')
  })

  it('loads production migration configuration with database-only credentials', () => {
    const config = loadDatabaseMigrationConfig({
      env: {
        NODE_ENV: 'production',
        DATABASE_URL:
          'postgresql://migrator@database.surfgate.example/surfgate?sslmode=verify-full',
      },
    })

    expect(config.database.url.username).toBe('migrator')
    expect(config.database.requiredMigration).toBe('0014-session-reconciliation-claim-index.sql')
  })

  it('loads reconciliation without Redis, object-storage, or relay-signing secrets', () => {
    const encryptionKey = Buffer.from(
      '2f6c986f2f85b0420b506c412bea1925d29c4827d4a6362041f00306e4cb385c',
      'hex',
    ).toString('base64')
    const config = loadReconciliationConfig({
      env: {
        NODE_ENV: 'production',
        DATABASE_URL:
          'postgresql://reconciler@database.surfgate.example/surfgate?sslmode=verify-full',
        CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
        CLOUDFLARE_BROWSER_RUN_API_TOKEN: 'provider-token',
        SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY: encryptionKey,
        SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY_ID: 'provider-session-v1',
      },
    })

    expect(config.database.url.username).toBe('reconciler')
    expect(config.security.relayTokenSigning).toBeUndefined()
    expect(config.security.providerSessionEncryption).toBeDefined()
  })

  it('loads relay configuration without object-storage credentials', () => {
    const config = loadRelayConfig({
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://relay@database.surfgate.example/surfgate?sslmode=verify-full',
        REDIS_URL: 'rediss://redis.surfgate.example',
        SURFGATE_RELAY_PUBLIC_URL: 'wss://relay.surfgate.example',
        CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
        CLOUDFLARE_BROWSER_RUN_API_TOKEN: 'provider-token',
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
        S3_ACCESS_KEY_ID: 'unrelated-partial-object-storage-credential',
      },
    })

    expect(config.relay.publicURL.hostname).toBe('relay.surfgate.example')
  })

  it('loads worker configuration without Redis or relay-signing credentials', () => {
    const config = loadWorkerConfig({
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://worker@database.surfgate.example/surfgate?sslmode=verify-full',
        S3_REGION: 'auto',
        S3_BUCKET: 'surfgate-artifacts',
        CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
        CLOUDFLARE_BROWSER_RUN_API_TOKEN: 'provider-token',
        SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY: Buffer.from(
          '2f6c986f2f85b0420b506c412bea1925d29c4827d4a6362041f00306e4cb385c',
          'hex',
        ).toString('base64'),
        SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY_ID: 'provider-session-v1',
      },
    })

    expect(config.objectStorage.bucket).toBe('surfgate-artifacts')
    expect(config.security.relayTokenSigning).toBeUndefined()
  })
})
