export type TraceContextCarrier = Readonly<{ traceparent: string }>

export type TelemetrySpan = Readonly<{
  run<Result>(operation: () => Result): Result
  context(): TraceContextCarrier | undefined
  end(outcome: 'success' | 'failure', attributes?: Readonly<Record<string, unknown>>): void
}>

export type StartTelemetrySpan = (
  name: string,
  attributes?: Readonly<Record<string, unknown>>,
  parent?: TraceContextCarrier,
) => TelemetrySpan

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

export type SessionReconciliationObservation = Readonly<{
  outcome: 'recovered' | 'unresolved' | 'suspected_provider_leak'
  count: number
}>

export type DependencyHealthObservation = Readonly<{
  dependency: 'postgresql' | 'redis' | 'object_storage'
  status: 'ready' | 'unavailable'
  durationMs: number
}>

export type RoutingDecisionObservation = Readonly<{
  outcome: 'selected' | 'no_compatible_runtime'
  policyVersion: string
  runtimeClass?: string
  providerID?: string
  rejectedReasonCodes: readonly string[]
}>

export type ControlPlaneOperationObservation = Readonly<{
  operation:
    | 'surfgate.quota.check'
    | 'surfgate.idempotency.resolve'
    | 'surfgate.routing.decide'
    | 'surfgate.routing.fallback'
    | 'surfgate.provider.health'
    | 'surfgate.provider.allocate'
    | 'surfgate.provider.terminate'
    | 'surfgate.session.persist'
  outcome: 'success' | 'failure'
  durationMs: number
  runtimeClass?: string
  providerID?: string
  policyVersion?: string
  healthState?: 'healthy' | 'degraded' | 'unavailable'
  reasonCode?: string
}>

/**
 * Shared control-plane telemetry boundary. Service bootstraps create the OTel
 * runtime once; domain and HTTP code emit bounded labels through this interface
 * rather than importing a global telemetry singleton.
 */
export interface ControlPlaneTelemetry {
  recordHTTP(input: HTTPObservation): void
  recordAuthentication(input: AuthenticationObservation): void
  recordDatabaseHealth(status: 'ready' | 'unavailable'): void
  recordDependencyHealth?(input: DependencyHealthObservation): void
  recordSessionTransition(input: SessionTransitionObservation): void
  recordSessionReconciliation?(input: SessionReconciliationObservation): void
  recordRoutingDecision?(input: RoutingDecisionObservation): void
  recordOperation?(input: ControlPlaneOperationObservation): void
  startSpan?: StartTelemetrySpan
}

export const NOOP_CONTROL_PLANE_TELEMETRY: ControlPlaneTelemetry = Object.freeze({
  recordHTTP(): void {},
  recordAuthentication(): void {},
  recordDatabaseHealth(): void {},
  recordSessionTransition(): void {},
  recordOperation(): void {},
})

export type RelayConnectionObservation = Readonly<{
  event: 'connect' | 'upstream_connect' | 'close' | 'backpressure' | 'auth_failure'
  outcome: 'success' | 'failure'
  durationMs?: number
  runtimeClass?: string
  providerID?: string
  reasonCode?: string
}>

export type RelayTrafficObservation = Readonly<{
  direction: 'client_to_upstream' | 'upstream_to_client'
  bytes: number
  frames: number
}>

export interface RelayTelemetry {
  recordConnection(input: RelayConnectionObservation): void
  recordTraffic(input: RelayTrafficObservation): void
  setActiveConnections(value: number): void
  startSpan?: StartTelemetrySpan
  recordDependencyHealth?(input: DependencyHealthObservation): void
}

export const NOOP_RELAY_TELEMETRY: RelayTelemetry = Object.freeze({
  recordConnection(): void {},
  recordTraffic(): void {},
  setActiveConnections(): void {},
})

export type ManagedTaskObservation = Readonly<{
  event: 'create' | 'claim' | 'execute' | 'retry' | 'artifact_upload' | 'artifact_access'
  taskType?: 'extract' | 'screenshot' | 'pdf'
  outcome: 'success' | 'failure'
  durationMs: number
  queueLatencyMs?: number
  attemptCount?: number
  reasonCode?: string
  bytes?: number
}>

export interface ManagedTaskTelemetry {
  recordTask(input: ManagedTaskObservation): void
  setActiveTasks(value: number): void
  startSpan?: StartTelemetrySpan
  captureTraceContext?(): TraceContextCarrier | undefined
  recordDependencyHealth?(input: DependencyHealthObservation): void
}

export const NOOP_MANAGED_TASK_TELEMETRY: ManagedTaskTelemetry = Object.freeze({
  recordTask(): void {},
  setActiveTasks(): void {},
})

export * from './telemetry.js'
export * from './runtime.js'
export * from './structured-logger.js'
