import type { ProviderDescriptor } from './provider-descriptor.js'
import type { ProviderHealth } from './provider-health.js'
import type {
  ProviderAllocateRequest,
  ProviderOperationOptions,
  ProviderSession,
  ProviderSessionRef,
  ProviderTerminationResult,
} from './provider-lifecycle.js'

export interface BrowserProvider {
  descriptor(): ProviderDescriptor
  health(options: ProviderOperationOptions): Promise<ProviderHealth>
  allocate(
    request: ProviderAllocateRequest,
    options: ProviderOperationOptions,
  ): Promise<ProviderSession>
  terminate(
    reference: ProviderSessionRef,
    options: ProviderOperationOptions,
  ): Promise<ProviderTerminationResult>
}
