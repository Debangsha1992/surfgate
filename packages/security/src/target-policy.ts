import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

export class TargetPolicyError extends Error {
  readonly code = 'POLICY_TARGET_FORBIDDEN' as const

  constructor() {
    super('The target is not permitted by policy.')
    this.name = 'TargetPolicyError'
  }
}

export interface TargetPolicy {
  validate(value: string): Promise<string>
}

export interface RedirectTargetPolicy extends TargetPolicy {
  validateRedirectChain(values: readonly string[]): Promise<readonly string[]>
}

type Resolver = (hostname: string) => Promise<readonly string[]>

const blocked = new BlockList()
const BLOCKED_IPV4_SUBNETS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const
for (const [network, prefix] of BLOCKED_IPV4_SUBNETS) {
  blocked.addSubnet(network, prefix, 'ipv4')
  blocked.addSubnet(`::ffff:${network}`, 96 + prefix, 'ipv6')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['fc00::', 7],
  ['fec0::', 10],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
] as const)
  blocked.addSubnet(network, prefix, 'ipv6')

function normalizedHostname(hostname: string): string {
  const unbracketed =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return unbracketed.replace(/\.+$/u, '').toLowerCase()
}

function forbiddenAddress(address: string): boolean {
  const family = isIP(address)
  return family === 0 || blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

async function defaultResolve(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

export function createTargetPolicy(
  options: Readonly<{
    resolve?: Resolver
    timeoutMs?: number
    maxAddresses?: number
    maxRedirects?: number
    resolutionPasses?: number
  }> = {},
): RedirectTargetPolicy {
  const resolve = options.resolve ?? defaultResolve
  const timeoutMs = options.timeoutMs ?? 2_000
  const maxAddresses = options.maxAddresses ?? 32
  const maxRedirects = options.maxRedirects ?? 5
  const resolutionPasses = options.resolutionPasses ?? 2
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(maxAddresses) ||
    maxAddresses < 1 ||
    maxAddresses > 256 ||
    !Number.isSafeInteger(maxRedirects) ||
    maxRedirects < 0 ||
    maxRedirects > 20 ||
    !Number.isSafeInteger(resolutionPasses) ||
    resolutionPasses < 1 ||
    resolutionPasses > 3
  ) {
    throw new Error('Target policy configuration is invalid.')
  }
  const boundedResolve = async (hostname: string): Promise<readonly string[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const addresses = await Promise.race([
        resolve(hostname),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new TargetPolicyError()), timeoutMs)
        }),
      ])
      if (addresses.length === 0 || addresses.length > maxAddresses) throw new TargetPolicyError()
      const normalized = [...new Set(addresses.map((address) => address.toLowerCase()))].toSorted()
      if (normalized.some(forbiddenAddress)) throw new TargetPolicyError()
      return normalized
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  const validate = async (value: string): Promise<string> => {
    let target: URL
    try {
      target = new URL(value)
      if (
        !['http:', 'https:'].includes(target.protocol) ||
        target.username !== '' ||
        target.password !== '' ||
        target.hostname.length === 0
      )
        throw new Error('forbidden')
      const hostname = normalizedHostname(target.hostname)
      if (hostname.length === 0) throw new Error('forbidden')
      if (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal')
      )
        throw new Error('forbidden')

      const literalFamily = isIP(hostname)
      if (literalFamily === 0) {
        let expected: readonly string[] | undefined
        for (let pass = 0; pass < resolutionPasses; pass += 1) {
          const addresses = await boundedResolve(hostname)
          if (expected !== undefined && addresses.join('\0') !== expected.join('\0')) {
            throw new TargetPolicyError()
          }
          expected = addresses
        }
        target.hostname = hostname
      } else if (forbiddenAddress(hostname)) {
        throw new TargetPolicyError()
      }
      return target.href
    } catch {
      throw new TargetPolicyError()
    }
  }
  return Object.freeze({
    validate,
    async validateRedirectChain(values: readonly string[]): Promise<readonly string[]> {
      if (values.length === 0 || values.length > maxRedirects + 1) throw new TargetPolicyError()
      const validated: string[] = []
      const seen = new Set<string>()
      for (const value of values) {
        const target = await validate(value)
        if (seen.has(target)) throw new TargetPolicyError()
        seen.add(target)
        validated.push(target)
      }
      return Object.freeze(validated)
    },
  })
}
