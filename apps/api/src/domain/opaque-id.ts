import { randomBytes } from 'node:crypto'

import {
  RoutingDecisionIDSchema,
  SessionIDSchema,
  type RoutingDecisionID,
  type SessionID,
} from '@surfgate/contracts'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function encode(value: bigint, length: number): string {
  let output = ''
  let remaining = value
  for (let index = 0; index < length; index += 1) {
    output = `${ALPHABET[Number(remaining & 31n)]}${output}`
    remaining >>= 5n
  }
  return output
}
function ulid(now: number): string {
  const random = randomBytes(10).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n)
  return `${encode(BigInt(now), 10)}${encode(random, 16)}`
}
export function generateSessionID(now = Date.now()): SessionID {
  return SessionIDSchema.parse(`ses_${ulid(now)}`)
}
export function generateRoutingDecisionID(now = Date.now()): RoutingDecisionID {
  return RoutingDecisionIDSchema.parse(`rtd_${ulid(now)}`)
}
export function generateOwnerToken(): string {
  return randomBytes(32).toString('base64url')
}
