import type { TenantID } from '@surfgate/contracts'

import type { Tenant } from '../domain/tenant.js'

export interface TenantRepository {
  findTenantByID(tenantID: TenantID): Promise<Tenant | null>
  insertTenant(tenant: Tenant): Promise<Tenant>
}
