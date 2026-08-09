import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

import { ConfigurationError } from './configuration-error.js'
import type { EnvironmentSource, SurfGateConfig } from './types.js'
import { parseConfig } from './validation.js'

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

export function loadConfig(options: LoadConfigOptions = {}): SurfGateConfig {
  const environment = options.env ?? process.env
  const runtimeEnvironment = environment.NODE_ENV?.trim() ?? 'development'
  if (runtimeEnvironment === 'production') {
    return parseConfig(environment)
  }

  const dotEnvPath = options.dotEnvPath ?? DEFAULT_DOT_ENV_PATH
  const dotEnv = readDotEnv(dotEnvPath, options.dotEnvPath === undefined)
  return parseConfig({ ...dotEnv, ...environment, NODE_ENV: runtimeEnvironment })
}
