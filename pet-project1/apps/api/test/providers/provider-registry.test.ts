import { describe, expect, it, vi } from 'vitest'

import {
  FakeBrowserProvider,
  createFakeProviderConfig,
  createFakeProviderDescriptor,
} from '@surfgate/testing'

import { ProviderRegistry } from '../../src/providers/provider-registry.js'
import { createRoutingCandidateID } from '@surfgate/router'

describe('ProviderRegistry', () => {
  const createProvider = (runtimeClass = 'test-browser') =>
    new FakeBrowserProvider(
      createFakeProviderConfig({
        descriptor: { ...createFakeProviderDescriptor(), runtimeClass },
      }),
    )

  it('builds deterministic provider-neutral sources and resolves a selected candidate', async () => {
    const chromium = createProvider('chromium')
    const kitesurf = createProvider('kitesurf')
    const registry = new ProviderRegistry([kitesurf, chromium])

    const sources = await registry.routingSources({ timeoutMs: 100 })

    expect(sources.map((source) => source.descriptor.runtimeClass)).toEqual([
      'chromium',
      'kitesurf',
    ])
    const provider = registry.resolve(sources[0]!.descriptor)
    expect(provider.descriptor().runtimeClass).toBe('chromium')
  })

  it('normalizes a thrown health check to unavailable', async () => {
    const provider = createProvider()
    vi.spyOn(provider, 'health').mockRejectedValueOnce(new Error('Bearer upstream-secret'))
    const registry = new ProviderRegistry([provider])

    const [source] = await registry.routingSources({ timeoutMs: 100 })
    expect(source?.health).toMatchObject({
      status: 'unavailable',
      configured: true,
      diagnosticCode: 'PROVIDER_UNAVAILABLE',
    })
    expect(JSON.stringify(source)).not.toContain('upstream-secret')
  })

  it('rejects duplicate canonical provider identities', () => {
    expect(() => new ProviderRegistry([createProvider(), createProvider()])).toThrow('unique')
  })

  it('resolves the exact configuration profile from canonical identity', () => {
    const descriptor = createFakeProviderDescriptor()
    const first = new FakeBrowserProvider(
      createFakeProviderConfig({ descriptor: { ...descriptor, configProfile: 'account-a' } }),
    )
    const second = new FakeBrowserProvider(
      createFakeProviderConfig({ descriptor: { ...descriptor, configProfile: 'account-b' } }),
    )
    const registry = new ProviderRegistry([second, first])

    const selected = first.descriptor()
    expect(
      registry.resolve({
        candidateID: createRoutingCandidateID(selected),
      }),
    ).toBe(first)
  })
})
