import {
  SURFGATE_ERROR_MESSAGES,
  type RequestID,
  type SurfGateErrorCode,
} from '@surfgate/contracts'

import type { APIKeyRepository } from '../repositories/api-key-repository.js'
import type { TenantRepository } from '../repositories/tenant-repository.js'
import {
  consumeDummyAPIKeyVerification,
  parseAPIKey,
  verifyAPIKeySecret,
  type APIKeyScope,
} from './api-key.js'
import type { AuthenticatedTenantContext } from './context.js'

export class AuthenticationError extends Error {
  readonly code: SurfGateErrorCode
  readonly reason: string

  constructor(code: SurfGateErrorCode, reason: string) {
    super(SURFGATE_ERROR_MESSAGES[code])
    this.name = 'AuthenticationError'
    this.code = code
    this.reason = reason
  }
}

function parseBearerAuthorization(authorization: string): string {
  const match = /^Bearer ([^\s]+)$/u.exec(authorization)
  if (match?.[1] === undefined) {
    throw new AuthenticationError('AUTH_INVALID_CREDENTIALS', 'malformed_authorization')
  }
  return match[1]
}

export function createAPIKeyAuthenticator(
  dependencies: Readonly<{
    apiKeys: APIKeyRepository
    tenants: TenantRepository
  }>,
) {
  return async function authenticate(
    input: Readonly<{
      authorization: string | undefined
      requestID: RequestID
      requiredScopes?: readonly APIKeyScope[]
      now?: Date
    }>,
  ): Promise<AuthenticatedTenantContext> {
    if (input.authorization === undefined) {
      throw new AuthenticationError('AUTH_UNAUTHORIZED', 'missing_authorization')
    }

    const plaintext = parseBearerAuthorization(input.authorization)
    let keyPrefix: string
    try {
      keyPrefix = parseAPIKey(plaintext).keyPrefix
    } catch {
      throw new AuthenticationError('AUTH_INVALID_CREDENTIALS', 'malformed_api_key')
    }

    const metadata = await dependencies.apiKeys.findAPIKeyByPrefix(keyPrefix)
    if (metadata === null) {
      await consumeDummyAPIKeyVerification(plaintext)
      throw new AuthenticationError('AUTH_INVALID_CREDENTIALS', 'credential_not_valid')
    }
    if (!(await verifyAPIKeySecret(plaintext, metadata))) {
      throw new AuthenticationError('AUTH_INVALID_CREDENTIALS', 'credential_not_valid')
    }

    const now = input.now ?? new Date()
    if (metadata.revokedAt !== undefined) {
      throw new AuthenticationError('AUTH_INVALID_CREDENTIALS', 'credential_revoked')
    }
    if (metadata.expiresAt !== undefined && Date.parse(metadata.expiresAt) <= now.getTime()) {
      throw new AuthenticationError('AUTH_INVALID_CREDENTIALS', 'credential_expired')
    }
    const tenant = await dependencies.tenants.findTenantByID(metadata.tenantID)
    if (tenant === null || tenant.status !== 'active') {
      throw new AuthenticationError('AUTH_INVALID_CREDENTIALS', 'credential_not_valid')
    }
    if (input.requiredScopes?.some((scope) => !metadata.scopes.includes(scope)) === true) {
      throw new AuthenticationError('AUTH_FORBIDDEN', 'scope_forbidden')
    }

    return Object.freeze({
      tenantID: tenant.id,
      apiKeyID: metadata.id,
      scopes: metadata.scopes,
      requestID: input.requestID,
    })
  }
}
