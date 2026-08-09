import type { QueryResultRow } from 'pg'

import { APIKeyMetadataSchema, type APIKeyMetadata } from '../auth/api-key.js'
import type { APIKeyRepository } from '../repositories/api-key-repository.js'
import type { Queryable } from './database.js'
import { optionalTimestampFromRow, timestampFromRow } from './row-values.js'

interface APIKeyRow extends QueryResultRow {
  id: unknown
  tenant_id: unknown
  key_prefix: unknown
  key_hash: unknown
  scopes: unknown
  created_at: unknown
  expires_at: unknown
  revoked_at: unknown
}

function apiKeyFromRow(row: APIKeyRow): APIKeyMetadata {
  const expiresAt = optionalTimestampFromRow(row.expires_at)
  const revokedAt = optionalTimestampFromRow(row.revoked_at)
  return APIKeyMetadataSchema.parse({
    id: row.id,
    tenantID: row.tenant_id,
    keyPrefix: row.key_prefix,
    keyHash: row.key_hash,
    scopes: row.scopes,
    createdAt: timestampFromRow(row.created_at),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  })
}

const API_KEY_COLUMNS =
  'id, tenant_id, key_prefix, key_hash, scopes, created_at, expires_at, revoked_at'

export class PostgresAPIKeyRepository implements APIKeyRepository {
  constructor(private readonly database: Queryable) {}

  async findAPIKeyByPrefix(keyPrefix: string): Promise<APIKeyMetadata | null> {
    const rows = await this.database.query<APIKeyRow>(
      `select ${API_KEY_COLUMNS} from api_keys where key_prefix = $1`,
      [keyPrefix],
    )
    return rows[0] === undefined ? null : apiKeyFromRow(rows[0])
  }

  async insertAPIKey(rawMetadata: APIKeyMetadata): Promise<APIKeyMetadata> {
    const metadata = APIKeyMetadataSchema.parse(rawMetadata)
    const rows = await this.database.query<APIKeyRow>(
      `insert into api_keys
         (id, tenant_id, key_prefix, key_hash, scopes, created_at, expires_at, revoked_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning ${API_KEY_COLUMNS}`,
      [
        metadata.id,
        metadata.tenantID,
        metadata.keyPrefix,
        metadata.keyHash,
        metadata.scopes,
        metadata.createdAt,
        metadata.expiresAt ?? null,
        metadata.revokedAt ?? null,
      ],
    )
    return apiKeyFromRow(rows[0]!)
  }
}
