import { randomBytes } from 'node:crypto'

import { RequestIDSchema, type RequestID } from '@surfgate/contracts'

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeBase32(value: bigint, length: number): string {
  let remaining = value
  let encoded = ''
  for (let index = 0; index < length; index += 1) {
    encoded = `${CROCKFORD_ALPHABET[Number(remaining & 31n)]}${encoded}`
    remaining >>= 5n
  }
  return encoded
}

export function generateRequestID(now: number = Date.now()): RequestID {
  const random = randomBytes(10).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n)
  const ulid = `${encodeBase32(BigInt(now), 10)}${encodeBase32(random, 16)}`
  return RequestIDSchema.parse(`req_${ulid}`)
}

export function resolveRequestID(header: string | string[] | undefined): RequestID {
  if (typeof header === 'string') {
    const parsed = RequestIDSchema.safeParse(header)
    if (parsed.success) {
      return parsed.data
    }
  }
  return generateRequestID()
}
