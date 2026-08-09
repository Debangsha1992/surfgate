export type HTTPObservation = Readonly<{
  method: string
  route: string
  statusCode: number
  durationMs: number
  outcome: 'success' | 'failure'
}>

export type AuthenticationObservation = Readonly<{
  outcome: 'success' | 'failure'
  reason: string
}>

export type SessionTransitionObservation = Readonly<{
  from: string
  to: string
  outcome: 'success' | 'conflict'
}>

export type ControlPlaneOperationObservation = Readonly<{
  operation:
    | 'surfgate.quota.check'
    | 'surfgate.routing.decide'
    | 'surfgate.provider.health'
    | 'surfgate.provider.allocate'
    | 'surfgate.provider.terminate'
    | 'surfgate.session.persist'
  outcome: 'success' | 'failure'
  durationMs: number
  runtimeClass?: string
  providerID?: string
  reasonCode?: string
}>

/**
 * OpenTelemetry-compatible control-plane hook boundary. The OTel SDK/exporter
 * bootstrap remains deployment-owned; domain and HTTP code emit bounded labels
 * through this interface rather than importing a global telemetry singleton.
 */
export interface ControlPlaneTelemetry {
  recordHTTP(input: HTTPObservation): void
  recordAuthentication(input: AuthenticationObservation): void
  recordDatabaseHealth(status: 'ready' | 'unavailable'): void
  recordSessionTransition(input: SessionTransitionObservation): void
  recordOperation?(input: ControlPlaneOperationObservation): void
}

export const NOOP_CONTROL_PLANE_TELEMETRY: ControlPlaneTelemetry = Object.freeze({
  recordHTTP(): void {},
  recordAuthentication(): void {},
  recordDatabaseHealth(): void {},
  recordSessionTransition(): void {},
  recordOperation(): void {},
})
