import type { TenantID } from '@surfgate/contracts'

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<number>
  health(): Promise<'ready' | 'unavailable'>
  close(): Promise<void>
}

export interface RequestRateLimiter {
  check(tenantID: TenantID, limit: number): Promise<void>
}

export class RateLimitExceededError extends Error {
  readonly code = 'QUOTA_EXCEEDED' as const
  constructor() {
    super('The applicable quota has been exceeded.')
    this.name = 'RateLimitExceededError'
  }
}

export class RateLimitDependencyError extends Error {
  readonly code = 'INTERNAL_DEPENDENCY_UNAVAILABLE' as const
  constructor() {
    super('A required service is unavailable.')
    this.name = 'RateLimitDependencyError'
  }
}

export function createRequestRateLimiter(
  store: RateLimitStore,
  options: Readonly<{ now?: () => number; windowMs?: number }> = {},
): RequestRateLimiter {
  const now = options.now ?? Date.now
  const windowMs = options.windowMs ?? 60_000
  return Object.freeze({
    async check(tenantID: TenantID, limit: number): Promise<void> {
      const window = Math.floor(now() / windowMs)
      try {
        const count = await store.increment(`surfgate:rate:${tenantID}:${window}`, windowMs)
        if (count > limit) throw new RateLimitExceededError()
      } catch (error: unknown) {
        if (error instanceof RateLimitExceededError) throw error
        throw new RateLimitDependencyError()
      }
    },
  })
}
