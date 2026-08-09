import { CapabilitySupportMapSchema } from '@surfgate/contracts'
import {
  ProviderDescriptorSchema,
  ProviderHealthSchema,
  type ProviderDescriptor,
  type ProviderHealth,
} from '@surfgate/provider-core'

import {
  RoutingInputSchema,
  buildRoutingCandidates,
  toRoutingCandidateIdentity,
  type RoutingInput,
  type RoutingInputSource,
} from '../src/index.js'

export const ROUTING_NOW = '2026-08-08T12:00:00.000Z'

export const KITESURF_SUPPORT = CapabilitySupportMapSchema.parse({
  javascript: 'experimental',
  dom: 'experimental',
  xhr: 'experimental',
  svg: 'experimental',
  screenshot: 'experimental',
  pdf: 'experimental',
  webgl: 'unsupported',
  video: 'unsupported',
  persistentAuth: 'unsupported',
  realBrowserTLS: 'unsupported',
  downloads: 'unknown',
  uploads: 'unknown',
  multiTab: 'unsupported',
  longSession: 'unsupported',
})

export const CHROMIUM_SUPPORT = CapabilitySupportMapSchema.parse({
  javascript: 'supported',
  dom: 'supported',
  xhr: 'supported',
  svg: 'supported',
  screenshot: 'supported',
  pdf: 'supported',
  webgl: 'supported',
  video: 'experimental',
  persistentAuth: 'supported',
  realBrowserTLS: 'supported',
  downloads: 'unknown',
  uploads: 'unknown',
  multiTab: 'supported',
  longSession: 'supported',
})

function descriptor(
  runtimeClass: 'kitesurf' | 'chromium',
  capabilities: typeof KITESURF_SUPPORT,
  overrides: Readonly<Record<string, unknown>> = {},
): ProviderDescriptor {
  return ProviderDescriptorSchema.parse({
    providerID: 'cloudflare-browser-run',
    runtimeClass,
    displayName: `Cloudflare Browser Run — ${runtimeClass}`,
    capabilities,
    implementation: { name: `@surfgate/provider-${runtimeClass}`, version: '2026-08-08' },
    configProfile: `browser-run-${runtimeClass}`,
    configured: true,
    ...overrides,
  })
}

function health(
  status: 'healthy' | 'degraded' | 'unavailable' = 'healthy',
  overrides: Readonly<Record<string, unknown>> = {},
): ProviderHealth {
  return ProviderHealthSchema.parse({
    status,
    configured: true,
    diagnosticCode:
      status === 'healthy'
        ? 'PROVIDER_HEALTHY'
        : status === 'degraded'
          ? 'PROVIDER_DEGRADED'
          : 'PROVIDER_UNAVAILABLE',
    capacity: status === 'degraded' ? 'constrained' : 'unknown',
    checkedAt: ROUTING_NOW,
    ...overrides,
  })
}

export function createKitesurfSource(
  overrides: Readonly<{
    descriptor?: Readonly<Record<string, unknown>>
    health?: ProviderHealth
    safety?: Readonly<Record<string, unknown>>
  }> = {},
): RoutingInputSource {
  return {
    descriptor: descriptor('kitesurf', KITESURF_SUPPORT, overrides.descriptor),
    health: overrides.health ?? health(),
    safety: {
      status: 'allowed',
      maximumSessionDurationMs: 600_000,
      ...overrides.safety,
    },
  }
}

export function createChromiumSource(
  overrides: Readonly<{
    descriptor?: Readonly<Record<string, unknown>>
    health?: ProviderHealth
    safety?: Readonly<Record<string, unknown>>
  }> = {},
): RoutingInputSource {
  return {
    descriptor: descriptor('chromium', CHROMIUM_SUPPORT, overrides.descriptor),
    health: overrides.health ?? health(),
    safety: {
      status: 'allowed',
      maximumSessionDurationMs: 86_400_000,
      ...overrides.safety,
    },
  }
}

export function createUnavailableHealth(configured = true): ProviderHealth {
  return ProviderHealthSchema.parse(
    configured
      ? {
          status: 'unavailable',
          configured: true,
          diagnosticCode: 'PROVIDER_UNAVAILABLE',
          capacity: 'unknown',
          checkedAt: ROUTING_NOW,
        }
      : {
          status: 'unavailable',
          configured: false,
          diagnosticCode: 'PROVIDER_NOT_CONFIGURED',
          capacity: 'unknown',
          checkedAt: ROUTING_NOW,
        },
  )
}

export function createDegradedHealth(): ProviderHealth {
  return health('degraded')
}

export const KITESURF_CANDIDATE = toRoutingCandidateIdentity(
  buildRoutingCandidates([createKitesurfSource()])[0]!,
)
export const CHROMIUM_CANDIDATE = toRoutingCandidateIdentity(
  buildRoutingCandidates([createChromiumSource()])[0]!,
)
export const SECOND_KITESURF_CANDIDATE = toRoutingCandidateIdentity(
  buildRoutingCandidates([createKitesurfSource({ descriptor: { region: 'secondary' } })])[0]!,
)
export const KITESURF_CANDIDATE_ID = KITESURF_CANDIDATE.candidateID
export const CHROMIUM_CANDIDATE_ID = CHROMIUM_CANDIDATE.candidateID

export function createRoutingInput(
  overrides: Readonly<Record<string, unknown>> = {},
): RoutingInput {
  return RoutingInputSchema.parse({
    decisionID: 'rtd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    tenantID: 'ten_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    requestID: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    createdAt: ROUTING_NOW,
    capabilityRegistryVersion: 'cap-2026-08-08',
    requirements: { javascript: 'required' },
    runtime: {
      preference: 'auto',
      allowFallback: true,
      allowExperimental: true,
    },
    maxSessionDurationMs: 60_000,
    tenantPolicy: {},
    candidateSources: [createKitesurfSource(), createChromiumSource()],
    signals: {},
    ...overrides,
  })
}
