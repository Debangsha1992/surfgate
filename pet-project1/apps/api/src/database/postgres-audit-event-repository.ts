import { AuditEventSchema, type AuditEventRepository } from '../domain/audit-event.js'
import type { Queryable } from './database.js'

export class PostgresAuditEventRepository implements AuditEventRepository {
  constructor(private readonly database: Queryable) {}

  async append(event: Parameters<AuditEventRepository['append']>[0]): Promise<void> {
    const validated = AuditEventSchema.parse(event)
    await this.database.query(
      `insert into audit_events
        (tenant_id, event_type, request_id, session_id, api_key_id, metadata, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        validated.tenantID,
        validated.type,
        validated.requestID,
        validated.sessionID ?? null,
        validated.apiKeyID ?? null,
        JSON.stringify(validated.metadata ?? {}),
        validated.createdAt,
      ],
    )
  }
}
