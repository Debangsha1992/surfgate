import {
  ProviderDescriptorSchema,
  ProviderHealthSchema,
  normalizeProviderError,
  type BrowserProvider,
  type ProviderDescriptor,
  type ProviderOperationOptions,
} from '@surfgate/provider-core'
import {
  RoutingInputSourceSchema,
  createRoutingCandidateID,
  type RoutingCandidateIdentity,
  type RoutingInputSource,
} from '@surfgate/router'

export class ProviderRegistry {
  readonly #providers: ReadonlyMap<string, BrowserProvider>

  constructor(providers: readonly BrowserProvider[]) {
    const entries = providers.map((provider) => {
      const descriptor = ProviderDescriptorSchema.parse(provider.descriptor())
      return [createRoutingCandidateID(descriptor), provider] as const
    })
    if (new Set(entries.map(([id]) => id)).size !== entries.length) {
      throw new Error('Provider registry identities must be unique.')
    }
    this.#providers = new Map(entries)
  }

  descriptors(): readonly ProviderDescriptor[] {
    return Object.freeze(
      [...this.#providers.values()]
        .map((provider) => ProviderDescriptorSchema.parse(provider.descriptor()))
        .toSorted((left, right) =>
          createRoutingCandidateID(left).localeCompare(createRoutingCandidateID(right)),
        ),
    )
  }

  async routingSources(options: ProviderOperationOptions): Promise<readonly RoutingInputSource[]> {
    const sources = await Promise.all(
      this.descriptors().map(async (descriptor) => {
        const provider = this.#providers.get(createRoutingCandidateID(descriptor))!
        const health = await provider.health(options).catch((error: unknown) => {
          if (options.signal?.aborted === true) throw normalizeProviderError(error, 'health')
          return ProviderHealthSchema.parse({
            status: 'unavailable',
            configured: descriptor.configured,
            diagnosticCode: descriptor.configured
              ? 'PROVIDER_UNAVAILABLE'
              : 'PROVIDER_NOT_CONFIGURED',
            capacity: 'unknown',
            checkedAt: new Date().toISOString(),
          })
        })
        return RoutingInputSourceSchema.parse({ descriptor, health })
      }),
    )
    return Object.freeze(sources)
  }

  resolve(
    identity: Pick<RoutingCandidateIdentity, 'candidateID'> | ProviderDescriptor,
  ): BrowserProvider {
    const candidateID =
      'candidateID' in identity
        ? identity.candidateID
        : createRoutingCandidateID(ProviderDescriptorSchema.parse(identity))
    const provider = this.#providers.get(candidateID)
    if (provider === undefined) throw new Error('Selected provider is not registered.')
    return provider
  }
}
