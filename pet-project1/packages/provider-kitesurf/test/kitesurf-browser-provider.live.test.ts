import { loadConfig } from '@surfgate/config'
import { ProviderSessionSchema, type ProviderSession } from '@surfgate/provider-core'
import { describe, expect, it } from 'vitest'

import { createKitesurfBrowserProvider } from '../src/index.js'
import { createKitesurfAllocateRequest } from './fixtures.js'

const config = loadConfig()
const liveTest = config.cloudflare.credentials === undefined ? it.skip : it

describe('KitesurfBrowserProvider live conformance', () => {
  liveTest(
    'allocates and terminates the smallest safe Kitesurf session',
    async () => {
      const provider = createKitesurfBrowserProvider(config.cloudflare)
      let session: ProviderSession | undefined

      try {
        session = await provider.allocate(createKitesurfAllocateRequest(), { timeoutMs: 30_000 })
        expect(ProviderSessionSchema.parse(session)).toEqual(session)
        expect(session.reference).toMatchObject({
          providerID: 'cloudflare-browser-run',
          runtimeClass: 'kitesurf',
        })
      } finally {
        if (session !== undefined) {
          await expect(
            provider.terminate(session.reference, { timeoutMs: 30_000 }),
          ).resolves.toMatchObject({ status: 'terminated' })
        }
      }
    },
    70_000,
  )
})
