import {
  ProviderAllocateRequestSchema,
  ProviderDescriptorSchema,
  type ProviderAllocateRequest,
  type ProviderDescriptor,
} from '@surfgate/provider-core'

export const FAKE_CAPABILITIES = {
  javascript: 'supported',
  dom: 'supported',
  xhr: 'supported',
  svg: 'supported',
  screenshot: 'supported',
  pdf: 'experimental',
  webgl: 'unsupported',
  video: 'unsupported',
  persistentAuth: 'experimental',
  realBrowserTLS: 'unknown',
  downloads: 'supported',
  uploads: 'supported',
  multiTab: 'supported',
  longSession: 'unknown',
} as const

export const FAKE_NOW_EPOCH_MS = Date.parse('2026-08-08T00:00:00.000Z')

export function createFakeProviderDescriptor(): ProviderDescriptor {
  return ProviderDescriptorSchema.parse({
    providerID: 'fake-provider',
    runtimeClass: 'test-browser',
    displayName: 'Deterministic Fake Browser',
    capabilities: FAKE_CAPABILITIES,
    implementation: {
      name: '@surfgate/testing/fake-browser-provider',
      version: '1.0.0',
    },
    region: 'local',
    configProfile: 'conformance',
    configured: true,
  })
}

export function createFakeAllocateRequest(): ProviderAllocateRequest {
  return ProviderAllocateRequestSchema.parse({
    requestID: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runtimeClass: 'test-browser',
    requirements: {
      javascript: 'required',
      screenshot: 'preferred',
    },
    allowExperimental: false,
    maxSessionDurationMs: 60_000,
    targetURL: 'https://example.test/',
    region: 'local',
    configProfile: 'conformance',
    metadata: {
      traceID: '4bf92f3577b34da6a3ce929d0e0e4736',
      operationName: 'provider.allocate',
    },
  })
}
