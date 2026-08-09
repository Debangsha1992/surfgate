import type { APIKeyMetadata } from '../auth/api-key.js'

export interface APIKeyRepository {
  /** Authentication-only lookup. Prefixes are globally unique and contain no secret material. */
  findAPIKeyByPrefix(keyPrefix: string): Promise<APIKeyMetadata | null>
  insertAPIKey(metadata: APIKeyMetadata): Promise<APIKeyMetadata>
}
