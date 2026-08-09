import { FakeBrowserProvider } from '../src/fake-browser-provider.js'
import { createFakeAllocateRequest, createFakeProviderDescriptor } from '../src/fixtures.js'
import {
  createFakeProviderConfig,
  runProviderConformanceSuite,
  type ProviderConformanceScenario,
} from '../src/index.js'

function createConformanceProvider(scenario: ProviderConformanceScenario): FakeBrowserProvider {
  const descriptor = createFakeProviderDescriptor()

  switch (scenario) {
    case 'default':
      return new FakeBrowserProvider(createFakeProviderConfig())
    case 'unconfigured':
      return new FakeBrowserProvider(
        createFakeProviderConfig({ descriptor: { ...descriptor, configured: false } }),
      )
    case 'degraded':
      return new FakeBrowserProvider(createFakeProviderConfig({ health: { behavior: 'degraded' } }))
    case 'unavailable':
      return new FakeBrowserProvider(
        createFakeProviderConfig({ health: { behavior: 'unavailable' } }),
      )
    case 'health_delayed':
    case 'health_timeout':
      return new FakeBrowserProvider(
        createFakeProviderConfig({ health: { behavior: 'healthy', delayMs: 100 } }),
      )
    case 'health_unknown_error':
      return new FakeBrowserProvider(
        createFakeProviderConfig({
          health: { behavior: 'throw_unknown', thrownValue: new Error('raw health response') },
        }),
      )
    case 'health_secret_error':
      return new FakeBrowserProvider(
        createFakeProviderConfig({
          health: {
            behavior: 'throw_unknown',
            thrownValue: new Error(
              'Bearer provider-secret from upstream.internal.local Authorization header',
            ),
          },
        }),
      )
    case 'allocation_delayed':
      return new FakeBrowserProvider(
        createFakeProviderConfig({ allocation: { behavior: 'success', delayMs: 100 } }),
      )
    case 'allocation_timeout':
      return new FakeBrowserProvider(
        createFakeProviderConfig({ allocation: { behavior: 'timeout' } }),
      )
    case 'allocation_configuration_error':
      return new FakeBrowserProvider(
        createFakeProviderConfig({ allocation: { behavior: 'configuration_error' } }),
      )
    case 'allocation_authorization_error':
      return new FakeBrowserProvider(
        createFakeProviderConfig({ allocation: { behavior: 'authorization_error' } }),
      )
    case 'allocation_rate_limited':
      return new FakeBrowserProvider(
        createFakeProviderConfig({ allocation: { behavior: 'rate_limited' } }),
      )
    case 'allocation_transient_error':
      return new FakeBrowserProvider(
        createFakeProviderConfig({ allocation: { behavior: 'transient_failure' } }),
      )
    case 'allocation_unsupported':
      return new FakeBrowserProvider(
        createFakeProviderConfig({ allocation: { behavior: 'unsupported' } }),
      )
    case 'allocation_connection_error':
      return new FakeBrowserProvider(
        createFakeProviderConfig({ allocation: { behavior: 'connection_failure' } }),
      )
    case 'allocation_unknown_error':
      return new FakeBrowserProvider(
        createFakeProviderConfig({
          allocation: { behavior: 'throw_unknown', thrownValue: 'non-error thrown value' },
        }),
      )
    case 'allocation_secret_error':
      return new FakeBrowserProvider(
        createFakeProviderConfig({
          allocation: {
            behavior: 'throw_unknown',
            thrownValue: new Error(
              'Bearer provider-secret from upstream.internal.local Authorization header',
            ),
          },
        }),
      )
    case 'termination_delayed':
      return new FakeBrowserProvider(
        createFakeProviderConfig({ termination: { behavior: 'success', delayMs: 100 } }),
      )
    case 'termination_timeout':
      return new FakeBrowserProvider(
        createFakeProviderConfig({ termination: { behavior: 'timeout' } }),
      )
    case 'termination_error':
      return new FakeBrowserProvider(
        createFakeProviderConfig({ termination: { behavior: 'failure' } }),
      )
    case 'termination_unknown_error':
      return new FakeBrowserProvider(
        createFakeProviderConfig({
          termination: { behavior: 'throw_unknown', thrownValue: 'non-error thrown value' },
        }),
      )
    case 'termination_secret_error':
      return new FakeBrowserProvider(
        createFakeProviderConfig({
          termination: {
            behavior: 'throw_unknown',
            thrownValue: new Error(
              'Bearer provider-secret from upstream.internal.local Authorization header',
            ),
          },
        }),
      )
  }
}

runProviderConformanceSuite({
  name: 'FakeBrowserProvider',
  createProvider: createConformanceProvider,
  allocateRequest: createFakeAllocateRequest,
})
