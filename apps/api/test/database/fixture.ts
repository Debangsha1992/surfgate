import { fileURLToPath } from 'node:url'

import { loadConfig } from '@surfgate/config'
import { afterAll, beforeAll, describe } from 'vitest'

import {
  assertTestDatabaseURL,
  createDatabase,
  type Database,
} from '../../src/database/database.js'
import { runMigrations } from '../../src/database/migrate.js'

export const configuredTestURL = loadConfig().database.testURL
export function describeWithDatabase(name: string, factory: () => void): void {
  if (configuredTestURL === undefined) {
    describe.skip(name, factory)
  } else {
    describe(name, factory)
  }
}

export let database: Database

beforeAll(async () => {
  if (configuredTestURL === undefined) {
    return
  }
  assertTestDatabaseURL(configuredTestURL)
  database = createDatabase({
    url: configuredTestURL,
    requiredMigration: '0014-session-reconciliation-claim-index.sql',
  })
  await runMigrations(database, fileURLToPath(new URL('../../migrations/', import.meta.url)))
})

afterAll(async () => {
  if (database !== undefined) {
    await database.close()
  }
})
