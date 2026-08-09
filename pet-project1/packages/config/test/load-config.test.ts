import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../src/index.js'

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
})
