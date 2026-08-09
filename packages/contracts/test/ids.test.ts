import { describe, expect, it } from 'vitest'

import {
  APIKeyIDSchema,
  ArtifactIDSchema,
  RequestIDSchema,
  RoutingDecisionIDSchema,
  SessionIDSchema,
  TaskIDSchema,
  TenantIDSchema,
  type RequestID,
  type SessionID,
} from '../src/index.js'

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('SurfGate IDs', () => {
  it.each([
    ['tenant', TenantIDSchema, `ten_${ULID}`],
    ['API key', APIKeyIDSchema, `key_${ULID}`],
    ['session', SessionIDSchema, `ses_${ULID}`],
    ['routing decision', RoutingDecisionIDSchema, `rtd_${ULID}`],
    ['task', TaskIDSchema, `tsk_${ULID}`],
    ['artifact', ArtifactIDSchema, `art_${ULID}`],
    ['request', RequestIDSchema, `req_${ULID}`],
  ])('accepts a canonical %s ID', (_name, schema, value) => {
    expect(schema.parse(value)).toBe(value)
  })

  it.each([
    ['wrong prefix', `ses_${ULID}`, TenantIDSchema],
    ['missing prefix', ULID, SessionIDSchema],
    ['short suffix', 'req_01ARZ3NDEK', RequestIDSchema],
    ['lowercase suffix', `tsk_${ULID.toLowerCase()}`, TaskIDSchema],
    ['ambiguous Crockford character', 'art_01ARZ3NDEKTSV4RRFFQ69G5FAI', ArtifactIDSchema],
    ['ULID overflow', `req_${'Z'.repeat(26)}`, RequestIDSchema],
  ])('rejects an invalid ID with a %s', (_name, value, schema) => {
    expect(schema.safeParse(value).success).toBe(false)
  })

  it('serializes branded IDs as their plain string representation', () => {
    const requestID = RequestIDSchema.parse(`req_${ULID}`)

    expect(JSON.stringify({ requestId: requestID })).toBe(`{"requestId":"req_${ULID}"}`)
  })

  it('keeps different ID categories opaque at compile time', () => {
    const requestID = RequestIDSchema.parse(`req_${ULID}`)
    const acceptsSessionID = (sessionID: SessionID): string => sessionID

    // @ts-expect-error A request ID must not be assignable to a session ID.
    const incorrectlyTypedSessionID: SessionID = requestID
    const correctlyTypedRequestID: RequestID = requestID

    expect(incorrectlyTypedSessionID).toBe(correctlyTypedRequestID)
    expect(() => acceptsSessionID(SessionIDSchema.parse(`ses_${ULID}`))).not.toThrow()
  })
})
