import { pathToFileURL } from 'node:url'

import { loadConfig } from '@surfgate/config'

import {
  API_KEY_SCOPES,
  issueAPIKey,
  type APIKeyMetadata,
  type APIKeyScope,
} from './auth/api-key.js'
import { createDatabase } from './database/database.js'
import { PostgresAPIKeyRepository } from './database/postgres-api-key-repository.js'
import { PostgresTenantRepository } from './database/postgres-tenant-repository.js'
import { TenantSchema, type Tenant } from './domain/tenant.js'
import { generateAPIKeyID, generateTenantID } from './domain/opaque-id.js'

export type DevelopmentAccess = Readonly<{
  tenantID: Tenant['id']
  apiKey: string
  apiKeyMetadata: APIKeyMetadata
  scopes: readonly APIKeyScope[]
}>

type BootstrapRepositories = Readonly<{
  insertTenant(tenant: Tenant): Promise<Tenant>
  insertAPIKey(metadata: APIKeyMetadata): Promise<APIKeyMetadata>
}>

export async function createDevelopmentAccess(
  repositories: BootstrapRepositories,
  now = new Date(),
): Promise<DevelopmentAccess> {
  const tenant = TenantSchema.parse({
    id: generateTenantID(now.getTime()),
    name: 'Local developer',
    status: 'active',
    plan: 'developer',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })
  const issued = await issueAPIKey({
    id: generateAPIKeyID(now.getTime()),
    tenantID: tenant.id,
    mode: 'test',
    scopes: API_KEY_SCOPES,
    now,
  })

  await repositories.insertTenant(tenant)
  await repositories.insertAPIKey(issued.metadata)

  return Object.freeze({
    tenantID: tenant.id,
    apiKey: issued.plaintext,
    apiKeyMetadata: issued.metadata,
    scopes: issued.metadata.scopes,
  })
}

async function runDevelopmentBootstrap(): Promise<void> {
  const config = loadConfig()
  if (config.runtime.environment === 'production') {
    throw new Error('Development access bootstrap is disabled in production.')
  }
  const database = createDatabase(config.database)
  try {
    const access = await database.transaction((transaction) =>
      createDevelopmentAccess({
        insertTenant: (tenant) => new PostgresTenantRepository(transaction).insertTenant(tenant),
        insertAPIKey: (metadata) =>
          new PostgresAPIKeyRepository(transaction).insertAPIKey(metadata),
      }),
    )
    process.stdout.write(
      `${JSON.stringify({ tenantId: access.tenantID, apiKey: access.apiKey, scopes: access.scopes }, null, 2)}\n`,
    )
  } finally {
    await database.close()
  }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  runDevelopmentBootstrap().catch(() => {
    console.error('Development access bootstrap failed.')
    process.exitCode = 1
  })
}
