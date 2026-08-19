import type { DatabaseConfig } from '@surfgate/config'
import { SessionIDSchema, TenantIDSchema, type SessionID, type TenantID } from '@surfgate/contracts'
import { Pool, type QueryResultRow } from 'pg'

import {
  RelaySessionRecordSchema,
  type RelaySessionRecord,
  type RelaySessionRepository,
} from './relay-types.js'

interface RelaySessionRow extends QueryResultRow {
  tenant_id: unknown
  id: unknown
  status: unknown
  expires_at: unknown
  provider_session_reference_encrypted: unknown
}

function timestamp(value: unknown): string | null {
  if (value === null) return null
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString()
  }
  throw new Error('Database returned an invalid relay session timestamp.')
}

export interface RelayDatabase extends RelaySessionRepository {
  health(): Promise<'ready' | 'unavailable'>
  close(): Promise<void>
}

export function createRelayDatabase(config: DatabaseConfig): RelayDatabase {
  const pool = new Pool({
    connectionString: config.url.href,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 60 * 30,
    query_timeout: 5_000,
    statement_timeout: 5_000,
    max: 10,
  })
  pool.on('error', () => undefined)
  return Object.freeze({
    async findSessionForTenant(
      rawTenantID: TenantID,
      rawSessionID: SessionID,
    ): Promise<RelaySessionRecord | null> {
      const tenantID = TenantIDSchema.parse(rawTenantID)
      const sessionID = SessionIDSchema.parse(rawSessionID)
      const result = await pool.query<RelaySessionRow>(
        `select tenant_id, id, status, expires_at, provider_session_reference_encrypted
         from sessions where tenant_id = $1 and id = $2`,
        [tenantID, sessionID],
      )
      const row = result.rows[0]
      return row === undefined
        ? null
        : RelaySessionRecordSchema.parse({
            tenantID: row.tenant_id,
            sessionID: row.id,
            status: row.status,
            expiresAt: timestamp(row.expires_at),
            providerSessionReferenceEncrypted: row.provider_session_reference_encrypted,
          })
    },
    async health(): Promise<'ready' | 'unavailable'> {
      try {
        const result = await pool.query<{ compatible: boolean }>(
          `select exists(
             select 1 from surfgate_migrations where name = $1
           ) as compatible`,
          [config.requiredMigration],
        )
        return result.rows[0]?.compatible === true ? 'ready' : 'unavailable'
      } catch {
        return 'unavailable'
      }
    },
    async close(): Promise<void> {
      await pool.end()
    },
  })
}
