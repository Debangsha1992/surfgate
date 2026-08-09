import type { APIKeyID, RequestID, TenantID } from '@surfgate/contracts'

import type { APIKeyScope } from './api-key.js'

export type AuthenticatedTenantContext = Readonly<{
  tenantID: TenantID
  apiKeyID: APIKeyID
  scopes: readonly APIKeyScope[]
  requestID: RequestID
}>
