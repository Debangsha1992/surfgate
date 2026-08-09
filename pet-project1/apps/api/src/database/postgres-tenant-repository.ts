import { TenantIDSchema, type TenantID } from '@surfgate/contracts'
import type { QueryResultRow } from 'pg'

import { TenantSchema, type Tenant } from '../domain/tenant.js'
import type { TenantRepository } from '../repositories/tenant-repository.js'
import type { Queryable } from './database.js'
import { timestampFromRow } from './row-values.js'

interface TenantRow extends QueryResultRow {
  id: unknown
  name: unknown
  status: unknown
  plan: unknown
  created_at: unknown
  updated_at: unknown
}

function tenantFromRow(row: TenantRow): Tenant {
  return TenantSchema.parse({
    id: row.id,
    name: row.name,
    status: row.status,
    plan: row.plan,
    createdAt: timestampFromRow(row.created_at),
    updatedAt: timestampFromRow(row.updated_at),
  })
}

export class PostgresTenantRepository implements TenantRepository {
  constructor(private readonly database: Queryable) {}

  async findTenantByID(tenantID: TenantID): Promise<Tenant | null> {
    const id = TenantIDSchema.parse(tenantID)
    const rows = await this.database.query<TenantRow>(
      `select id, name, status, plan, created_at, updated_at
       from tenants where id = $1`,
      [id],
    )
    return rows[0] === undefined ? null : tenantFromRow(rows[0])
  }

  async insertTenant(rawTenant: Tenant): Promise<Tenant> {
    const tenant = TenantSchema.parse(rawTenant)
    const rows = await this.database.query<TenantRow>(
      `insert into tenants (id, name, status, plan, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6)
       returning id, name, status, plan, created_at, updated_at`,
      [tenant.id, tenant.name, tenant.status, tenant.plan, tenant.createdAt, tenant.updatedAt],
    )
    return tenantFromRow(rows[0]!)
  }
}
