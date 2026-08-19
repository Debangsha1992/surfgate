import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

import { ConfigurationError } from './configuration-error.js'
import type {
  DatabaseMigrationConfig,
  EnvironmentSource,
  ReconciliationConfig,
  RelayServiceConfig,
  SurfGateConfig,
  WorkerServiceConfig,
} from './types.js'
import {
  parseConfig,
  parseDatabaseMigrationConfig,
  parseReconciliationConfig,
  parseRelayConfig,
  parseWorkerConfig,
} from './validation.js'

const DEFAULT_DOT_ENV_PATH = new URL('../../../.env', import.meta.url)

export type LoadConfigOptions = Readonly<{
  env?: EnvironmentSource
  dotEnvPath?: string | URL
}>

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === 'ENOENT'
  )
}

function readDotEnv(path: string | URL, optional: boolean): EnvironmentSource {
  try {
    return parseEnv(readFileSync(path, 'utf8'))
  } catch (error: unknown) {
    if (optional && isMissingFile(error)) {
      return {}
    }
    throw new ConfigurationError([{ key: '.env', message: 'could not be read or parsed' }])
  }
}

function loadEnvironment(options: LoadConfigOptions): EnvironmentSource {
  const environment = options.env ?? process.env
  const runtimeEnvironment = environment.NODE_ENV?.trim() ?? 'development'
  if (runtimeEnvironment === 'production') {
    return environment
  }

  const dotEnvPath = options.dotEnvPath ?? DEFAULT_DOT_ENV_PATH
  const dotEnv = readDotEnv(dotEnvPath, options.dotEnvPath === undefined)
  return { ...dotEnv, ...environment, NODE_ENV: runtimeEnvironment }
}

export function loadConfig(options: LoadConfigOptions = {}): SurfGateConfig {
  return parseConfig(loadEnvironment(options))
}

export function loadDatabaseMigrationConfig(
  options: LoadConfigOptions = {},
): DatabaseMigrationConfig {
  return parseDatabaseMigrationConfig(loadEnvironment(options))
}

export function loadReconciliationConfig(options: LoadConfigOptions = {}): ReconciliationConfig {
  return parseReconciliationConfig(loadEnvironment(options))
}

export function loadRelayConfig(options: LoadConfigOptions = {}): RelayServiceConfig {
  return parseRelayConfig(loadEnvironment(options))
}

export function loadWorkerConfig(options: LoadConfigOptions = {}): WorkerServiceConfig {
  return parseWorkerConfig(loadEnvironment(options))
}
