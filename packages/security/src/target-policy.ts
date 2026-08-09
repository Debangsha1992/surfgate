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

type Resolver = (hostname: string) => Promise<readonly string[]>

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const)
  blocked.addSubnet(network, prefix, 'ipv6')

function normalizedHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
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
  options: Readonly<{ resolve?: Resolver; timeoutMs?: number }> = {},
): TargetPolicy {
  const resolve = options.resolve ?? defaultResolve
  const timeoutMs = options.timeoutMs ?? 2_000
  return Object.freeze({
    async validate(value: string): Promise<string> {
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
        const hostname = normalizedHostname(target.hostname).toLowerCase()
        if (
          hostname === 'localhost' ||
          hostname.endsWith('.localhost') ||
          hostname.endsWith('.local') ||
          hostname.endsWith('.internal')
        )
          throw new Error('forbidden')

        const literalFamily = isIP(hostname)
        const addresses =
          literalFamily === 0
            ? await new Promise<readonly string[]>((resolveResult, reject) => {
                const timer = setTimeout(() => reject(new TargetPolicyError()), timeoutMs)
                resolve(hostname)
                  .then(resolveResult, reject)
                  .finally(() => clearTimeout(timer))
              })
            : [hostname]
        if (addresses.length === 0 || addresses.some(forbiddenAddress)) throw new Error('forbidden')
        return target.href
      } catch {
        throw new TargetPolicyError()
      }
    },
  })
}
