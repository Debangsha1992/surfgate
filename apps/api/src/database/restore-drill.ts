import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'

import { loadDatabaseMigrationConfig } from '@surfgate/config'
import { Pool } from 'pg'

import { assertTestDatabaseURL } from './database.js'

const POSTGRES_IDENTIFIER_MAX_BYTES = 63

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

export function createRestoreDatabaseName(sourceDatabase: string): string {
  const targetDatabase = `surfgate_restore_${randomBytes(16).toString('hex')}`
  if (
    Buffer.byteLength(targetDatabase, 'utf8') > POSTGRES_IDENTIFIER_MAX_BYTES ||
    targetDatabase === sourceDatabase
  ) {
    throw new Error('Restore database name is unsafe.')
  }
  return targetDatabase
}

function run(
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false
    const child = spawn(command, [...arguments_], {
      env: environment,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    let forceKillTimer: NodeJS.Timeout | undefined
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      forceKillTimer.unref()
    }, timeoutMs)
    timeout.unref()
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
      if (error === undefined) resolve()
      else reject(error)
    }
    child.once('error', () => finish(new Error('PostgreSQL restore tool is unavailable.')))
    child.once('exit', (code) => {
      if (timedOut) finish(new Error('PostgreSQL restore drill command timed out.'))
      else if (code === 0) finish()
      else finish(new Error('PostgreSQL restore drill command failed.'))
    })
  })
}

function postgresEnvironment(url: URL, database: string): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
    ...(url.searchParams.get('sslmode') === null
      ? {}
      : { PGSSLMODE: url.searchParams.get('sslmode')! }),
  }
}

export async function runPostgresRestoreDrill(
  testURL: URL,
  requiredMigration: string,
): Promise<void> {
  assertTestDatabaseURL(testURL)
  const sourceDatabase = decodeURIComponent(testURL.pathname.slice(1))
  const targetDatabase = createRestoreDatabaseName(sourceDatabase)
  if (!/^[a-zA-Z0-9_]+$/u.test(targetDatabase)) throw new Error('Restore database name is unsafe.')
  const adminURL = new URL(testURL)
  adminURL.pathname = '/postgres'
  const admin = new Pool({
    connectionString: adminURL.href,
    max: 1,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  })
  const directory = await mkdtemp(join(tmpdir(), 'surfgate-restore-drill-'))
  const dump = join(directory, 'surfgate.dump')
  const sourceEnvironment = postgresEnvironment(testURL, sourceDatabase)
  const targetEnvironment = postgresEnvironment(testURL, targetDatabase)
  let primaryError: unknown
  let createMayHaveSucceeded = false
  try {
    await run('pg_dump', ['--format=custom', '--file', dump], sourceEnvironment, 300_000)
    const existing = await admin.query<{ exists: boolean }>(
      'select exists(select 1 from pg_database where datname=$1) as exists',
      [targetDatabase],
    )
    if (existing.rows[0]?.exists === true) throw new Error('Restore database name collision.')
    createMayHaveSucceeded = true
    try {
      await admin.query(`create database "${targetDatabase}"`)
    } catch (error: unknown) {
      if (postgresErrorCode(error) === '42P04') createMayHaveSucceeded = false
      throw error
    }
    await run(
      'pg_restore',
      ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', targetDatabase, dump],
      targetEnvironment,
      300_000,
    )
    const restoredURL = new URL(testURL)
    restoredURL.pathname = `/${targetDatabase}`
    const restored = new Pool({
      connectionString: restoredURL.href,
      max: 1,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      statement_timeout: 10_000,
    })
    try {
      const result = await restored.query<{ compatible: boolean }>(
        `select exists(
           select 1 from surfgate_migrations where name = $1
         ) as compatible`,
        [requiredMigration],
      )
      if (result.rows[0]?.compatible !== true) {
        throw new Error('Restored database schema is incompatible.')
      }
    } finally {
      await restored.end()
    }
  } catch (error: unknown) {
    primaryError = error
  }

  let cleanupFailed = false
  if (createMayHaveSucceeded) {
    try {
      await admin.query(`drop database if exists "${targetDatabase}" with (force)`)
    } catch {
      cleanupFailed = true
    }
  }
  const cleanup = await Promise.allSettled([
    admin.end(),
    rm(directory, { recursive: true, force: true }),
  ])
  cleanupFailed ||= cleanup.some((result) => result.status === 'rejected')
  if (primaryError !== undefined) {
    throw primaryError instanceof Error
      ? primaryError
      : new Error('PostgreSQL restore drill failed.')
  }
  if (cleanupFailed) throw new Error('PostgreSQL restore drill cleanup failed.')
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const database = loadDatabaseMigrationConfig().database
  const testURL = database.testURL
  if (testURL === undefined) throw new Error('TEST_DATABASE_URL is required for a restore drill.')
  runPostgresRestoreDrill(testURL, database.requiredMigration).catch(() => {
    process.stderr.write('{"event":"database.restore_drill.failed"}\n')
    process.exitCode = 1
  })
}
