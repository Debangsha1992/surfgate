export const ROUTER_POLICY_VERSION = 'router-v1' as const

const ROUTER_V1_WEIGHTS = Object.freeze({
  preference: 30,
  efficiency: 25,
  compatibility: 20,
  health: 15,
  latency: 5,
  capacity: 5,
})

export const ROUTER_V1_POLICY = Object.freeze({
  version: ROUTER_POLICY_VERSION,
  weights: ROUTER_V1_WEIGHTS,
  defaultSignalScore: 50,
  runtimeEfficiencyScores: Object.freeze({
    kitesurf: 100,
    chromium: 60,
  }),
  defaultRuntimeEfficiencyScore: 50,
  healthScores: Object.freeze({
    healthy: 100,
    degraded: 50,
    unavailable: 0,
  }),
  capacityScores: Object.freeze({
    available: 100,
    constrained: 25,
    exhausted: 0,
    unknown: 50,
  }),
  preferredCapabilityScores: Object.freeze({
    supported: 100,
    experimentalAllowed: 80,
    experimentalNotAllowed: 40,
    unknown: 25,
    unsupported: 0,
  }),
  explicitPreferenceMatchScore: 100,
  explicitPreferenceMismatchScore: 0,
  tenantPreferenceMatchScore: 100,
  tenantPreferenceMismatchScore: 25,
  neutralPreferenceScore: 50,
  fastPathEfficiencyThreshold: 90,
  lowCompatibilityThreshold: 40,
  maximumCrossRuntimeFallbacks: 1,
})
