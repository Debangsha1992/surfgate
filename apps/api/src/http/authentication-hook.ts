import { RequestIDSchema } from '@surfgate/contracts'
import type { ControlPlaneTelemetry, TelemetrySpan } from '@surfgate/observability'
import type { preHandlerAsyncHookHandler } from 'fastify'

import type { APIKeyScope } from '../auth/api-key.js'
import { AuthenticationError } from '../auth/authentication.js'
import type { AuthenticatedTenantContext } from '../auth/context.js'

export type AuthenticateAPIKey = (
  input: Readonly<{
    authorization: string | undefined
    requestID: AuthenticatedTenantContext['requestID']
    requiredScopes?: readonly APIKeyScope[]
  }>,
) => Promise<AuthenticatedTenantContext>

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthenticatedTenantContext
    startedAtMonotonic: number
    telemetrySpan: TelemetrySpan | undefined
  }
}

export function createAuthenticationHook(
  dependencies: Readonly<{
    authenticate: AuthenticateAPIKey
    telemetry: ControlPlaneTelemetry
    requiredScopes?: readonly APIKeyScope[]
  }>,
): preHandlerAsyncHookHandler {
  return async (request) => {
    try {
      request.auth = await dependencies.authenticate({
        authorization: request.headers.authorization,
        requestID: RequestIDSchema.parse(request.id),
        ...(dependencies.requiredScopes === undefined
          ? {}
          : { requiredScopes: dependencies.requiredScopes }),
      })
      dependencies.telemetry.recordAuthentication({
        outcome: 'success',
        reason: 'authenticated',
      })
    } catch (error: unknown) {
      dependencies.telemetry.recordAuthentication({
        outcome: 'failure',
        reason: error instanceof AuthenticationError ? error.reason : 'internal_error',
      })
      throw error
    }
  }
}
