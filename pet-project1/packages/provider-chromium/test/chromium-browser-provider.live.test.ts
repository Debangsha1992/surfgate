import { loadConfig } from '@surfgate/config'
import { ProviderSessionSchema, type ProviderSession } from '@surfgate/provider-core'
import { describe, expect, it } from 'vitest'

import { createChromiumBrowserProvider } from '../src/index.js'
import { createChromiumAllocateRequest } from './fixtures.js'

const config = loadConfig()
const liveTest = config.cloudflare.credentials === undefined ? it.skip : it

describe('ChromiumBrowserProvider live conformance', () => {
  liveTest(
    'allocates and terminates the smallest safe Chromium session',
    async () => {
      const provider = createChromiumBrowserProvider(config.cloudflare)
      let session: ProviderSession | undefined

      try {
        session = await provider.allocate(createChromiumAllocateRequest(), { timeoutMs: 30_000 })
        expect(ProviderSessionSchema.parse(session)).toEqual(session)
        expect(session.reference).toMatchObject({
          providerID: 'cloudflare-browser-run',
          runtimeClass: 'chromium',
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
