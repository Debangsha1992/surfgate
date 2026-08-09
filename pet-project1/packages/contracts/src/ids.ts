import { z } from 'zod'

const CROCKFORD_ULID_PATTERN = '[0-7][0-9A-HJKMNP-TV-Z]{25}'

function createOpaqueIDSchema<Brand extends string>(prefix: string, brand: Brand) {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}_${CROCKFORD_ULID_PATTERN}$`),
      `Expected a ${brand} with the ${prefix}_ prefix and a 26-character Crockford ULID`,
    )
    .brand<Brand>()
}

export const TenantIDSchema = createOpaqueIDSchema('ten', 'TenantID')
export type TenantID = z.infer<typeof TenantIDSchema>

export const APIKeyIDSchema = createOpaqueIDSchema('key', 'APIKeyID')
export type APIKeyID = z.infer<typeof APIKeyIDSchema>

export const SessionIDSchema = createOpaqueIDSchema('ses', 'SessionID')
export type SessionID = z.infer<typeof SessionIDSchema>

export const RoutingDecisionIDSchema = createOpaqueIDSchema('rtd', 'RoutingDecisionID')
export type RoutingDecisionID = z.infer<typeof RoutingDecisionIDSchema>

export const TaskIDSchema = createOpaqueIDSchema('tsk', 'TaskID')
export type TaskID = z.infer<typeof TaskIDSchema>

export const ArtifactIDSchema = createOpaqueIDSchema('art', 'ArtifactID')
export type ArtifactID = z.infer<typeof ArtifactIDSchema>

export const RequestIDSchema = createOpaqueIDSchema('req', 'RequestID')
export type RequestID = z.infer<typeof RequestIDSchema>
