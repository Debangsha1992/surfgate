import {
  SpanStatusCode,
  context,
  isSpanContextValid,
  trace,
  type Attributes,
  type Context,
  type Meter,
  type Tracer,
} from '@opentelemetry/api'
import { SURFGATE_ERROR_CODES, TASK_FAILURE_CODES } from '@surfgate/contracts'
import { PROVIDER_ERROR_CODES } from '@surfgate/provider-core'
import {
  FALLBACK_FAILURE_CLASSES,
  ROUTER_POLICY_VERSION,
  ROUTING_REASON_CODES,
} from '@surfgate/router'

import type {
  ControlPlaneOperationObservation,
  ControlPlaneTelemetry,
  DependencyHealthObservation,
  HTTPObservation,
  AuthenticationObservation,
  SessionTransitionObservation,
  ManagedTaskObservation,
  ManagedTaskTelemetry,
  RelayConnectionObservation,
  RelayTrafficObservation,
  RelayTelemetry,
  RoutingDecisionObservation,
  TelemetrySpan,
  TraceContextCarrier,
} from './index.js'

const TRACE_PARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/u
const MAX_ATTRIBUTE_LENGTH = 128
const ROUTE_TEMPLATES = new Set([
  '/health/live',
  '/health/ready',
  '/openapi.json',
  '/v1/sessions',
  '/v1/sessions/:sessionId',
  '/v1/sessions/:sessionId/relay-token',
  '/v1/sessions/:sessionId/tasks',
  '/v1/tasks/:taskId',
  '/v1/artifacts/:artifactId',
  'unmatched',
])

const SAFE_ATTRIBUTE_KEYS = new Set([
  'attemptCount',
  'direction',
  'event',
  'fallback',
  'from',
  'healthState',
  'method',
  'operation',
  'outcome',
  'providerID',
  'policyVersion',
  'reasonCode',
  'route',
  'runtimeClass',
  'statusCode',
  'taskType',
  'to',
])

const METRIC_HTTP_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'])
const METRIC_EVENTS = new Set([
  'artifact_access',
  'artifact_upload',
  'auth_failure',
  'backpressure',
  'claim',
  'close',
  'connect',
  'create',
  'execute',
  'retry',
  'upstream_connect',
])
const METRIC_OPERATIONS = new Set([
  'object_storage',
  'postgresql',
  'redis',
  'surfgate.idempotency.resolve',
  'surfgate.provider.allocate',
  'surfgate.provider.health',
  'surfgate.provider.terminate',
  'surfgate.quota.check',
  'surfgate.routing.decide',
  'surfgate.routing.fallback',
  'surfgate.session.persist',
])
const METRIC_OUTCOMES = new Set([
  'conflict',
  'failure',
  'no_compatible_runtime',
  'ready',
  'selected',
  'success',
  'unavailable',
])
const METRIC_PROVIDER_IDS = new Set(['cloudflare-browser-run', 'fake-provider'])
const METRIC_RUNTIME_CLASSES = new Set(['chromium', 'kitesurf', 'test-browser'])
const METRIC_SESSION_STATES = new Set([
  'active',
  'allocating',
  'expired',
  'failed',
  'fallback_allocating',
  'pending',
  'routing',
  'terminated',
  'terminating',
])
const METRIC_REASON_CODES = new Set<string>([
  ...SURFGATE_ERROR_CODES,
  ...TASK_FAILURE_CODES,
  ...PROVIDER_ERROR_CODES,
  ...ROUTING_REASON_CODES,
  ...FALLBACK_FAILURE_CLASSES,
  'ABSOLUTE_TIMEOUT',
  'AUTH_INVALID',
  'AUTH_REQUIRED',
  'BACKPRESSURE_LIMIT',
  'CLIENT_CLOSED',
  'CLOUDFLARE_API_BASE_URL_INVALID',
  'CLOUDFLARE_CREATE_RESPONSE_INVALID',
  'CLOUDFLARE_CREDENTIALS_INVALID',
  'CLOUDFLARE_NOT_CONFIGURED',
  'CLOUDFLARE_PROFILE_INVALID',
  'CLOUDFLARE_TERMINATE_RESPONSE_INVALID',
  'CONNECTION_CONFLICT',
  'IDLE_TIMEOUT',
  'INTERNAL_ERROR',
  'MESSAGE_TOO_LARGE',
  'OTHER',
  'PROVIDER_DEGRADED',
  'PROVIDER_HEALTHY',
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_UNAVAILABLE',
  'SESSION_EXPIRED',
  'SESSION_NOT_CONNECTABLE',
  'SESSION_NOT_FOUND',
  'SESSION_REVOKED',
  'TOKEN_EXPIRED',
  'UPSTREAM_CLOSED',
  'UPSTREAM_CONNECT_FAILED',
  'authenticated',
  'credential_expired',
  'credential_not_valid',
  'credential_revoked',
  'internal_error',
  'malformed_api_key',
  'malformed_authorization',
  'missing_authorization',
  'scope_forbidden',
])
const METRIC_DIRECTIONS = new Set(['client_to_upstream', 'upstream_to_client'])
const METRIC_HEALTH_STATES = new Set(['degraded', 'healthy', 'unavailable'])
const METRIC_TASK_TYPES = new Set(['extract', 'pdf', 'screenshot'])

function boundedMetricString(raw: string, allowed: ReadonlySet<string>): string {
  return allowed.has(raw) ? raw : 'OTHER'
}

function metricReasonCode(raw: string): string {
  if (METRIC_REASON_CODES.has(raw)) return raw
  const cloudflareHTTP = /^CLOUDFLARE_HTTP_([1-5])[0-9]{2}$/u.exec(raw)
  return cloudflareHTTP?.[1] === undefined ? 'OTHER' : `CLOUDFLARE_HTTP_${cloudflareHTTP[1]}XX`
}

function metricAttributes(input: Readonly<Record<string, unknown>>): Attributes {
  const attributes: Attributes = {}
  for (const [key, raw] of Object.entries(input)) {
    if (key === 'fallback' && typeof raw === 'boolean') attributes[key] = raw
    else if (key === 'attemptCount' && typeof raw === 'number' && Number.isFinite(raw)) {
      attributes[key] = Math.min(10, Math.max(0, Math.trunc(raw)))
    } else if (key === 'statusCode' && typeof raw === 'number' && Number.isFinite(raw)) {
      const statusClass = Math.floor(raw / 100) * 100
      attributes[key] = statusClass >= 100 && statusClass <= 500 ? statusClass : 0
    } else if (typeof raw === 'string') {
      if (key === 'direction') attributes[key] = boundedMetricString(raw, METRIC_DIRECTIONS)
      else if (key === 'event') attributes[key] = boundedMetricString(raw, METRIC_EVENTS)
      else if (key === 'from' || key === 'to') {
        attributes[key] = boundedMetricString(raw, METRIC_SESSION_STATES)
      } else if (key === 'healthState') {
        attributes[key] = boundedMetricString(raw, METRIC_HEALTH_STATES)
      } else if (key === 'method') {
        attributes[key] = boundedMetricString(raw.toUpperCase(), METRIC_HTTP_METHODS)
      } else if (key === 'operation') {
        attributes[key] = boundedMetricString(raw, METRIC_OPERATIONS)
      } else if (key === 'outcome') {
        attributes[key] = boundedMetricString(raw, METRIC_OUTCOMES)
      } else if (key === 'policyVersion') {
        attributes[key] = raw === ROUTER_POLICY_VERSION ? raw : 'OTHER'
      } else if (key === 'providerID') {
        attributes[key] = boundedMetricString(raw, METRIC_PROVIDER_IDS)
      } else if (key === 'reasonCode') attributes[key] = metricReasonCode(raw)
      else if (key === 'route') attributes[key] = normalizeMetricRoute(raw)
      else if (key === 'runtimeClass') {
        attributes[key] = boundedMetricString(raw, METRIC_RUNTIME_CLASSES)
      } else if (key === 'taskType') {
        attributes[key] = boundedMetricString(raw, METRIC_TASK_TYPES)
      }
    }
  }
  return attributes
}

function boundedAttributes(input: Readonly<Record<string, unknown>>): Attributes {
  const attributes: Attributes = {}
  for (const [key, raw] of Object.entries(input)) {
    if (!SAFE_ATTRIBUTE_KEYS.has(key)) continue
    if (typeof raw === 'boolean' || typeof raw === 'number') {
      if (typeof raw === 'number' && !Number.isFinite(raw)) continue
      attributes[key] = raw
      continue
    }
    if (typeof raw === 'string' && raw.length <= MAX_ATTRIBUTE_LENGTH) attributes[key] = raw
  }
  return attributes
}

export function normalizeMetricRoute(route: string): string {
  return ROUTE_TEMPLATES.has(route) ? route : 'unmatched'
}

export function injectTraceContext(
  source: Context = context.active(),
): TraceContextCarrier | undefined {
  const spanContext = trace.getSpanContext(source)
  if (spanContext === undefined || !isSpanContextValid(spanContext)) return undefined
  const flags = (spanContext.traceFlags & 1).toString(16).padStart(2, '0')
  const traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`
  return Object.freeze({ traceparent })
}

export function extractTraceContext(
  carrier: TraceContextCarrier | undefined,
  base: Context = context.active(),
): Context {
  if (carrier === undefined || !TRACE_PARENT_PATTERN.test(carrier.traceparent)) return base
  const [, traceId, spanId, traceFlags] = carrier.traceparent.split('-')
  if (traceId === undefined || spanId === undefined || traceFlags === undefined) return base
  return trace.setSpanContext(base, {
    traceId,
    spanId,
    traceFlags: Number.parseInt(traceFlags, 16),
    isRemote: true,
  })
}

export function traceIDFromCarrier(carrier: TraceContextCarrier | undefined): string | undefined {
  if (carrier === undefined || !TRACE_PARENT_PATTERN.test(carrier.traceparent)) return undefined
  return carrier.traceparent.split('-')[1]
}

function endRecordedSpan(
  tracer: Tracer,
  name: string,
  input: Readonly<Record<string, unknown>>,
  durationMs = 0,
): void {
  const endTime = Date.now()
  const span = tracer.startSpan(name, {
    attributes: boundedAttributes(input),
    startTime: endTime - Math.max(0, durationMs),
  })
  const outcome = input.outcome
  span.setStatus({
    code: outcome === 'failure' ? SpanStatusCode.ERROR : SpanStatusCode.OK,
  })
  span.end(endTime)
}

export type TelemetryAdapters = Readonly<{
  tracer: Tracer
  controlPlane: ControlPlaneTelemetry
  relay: RelayTelemetry
  managedTasks: ManagedTaskTelemetry
  startSpan(
    name: string,
    attributes?: Readonly<Record<string, unknown>>,
    parent?: TraceContextCarrier,
  ): TelemetrySpan
  recordSpan(name: string, attributes: Readonly<Record<string, unknown>>, durationMs?: number): void
}>

export function createTelemetryAdapters(
  input: Readonly<{
    serviceName: string
    tracer: Tracer
    meter: Meter
  }>,
): TelemetryAdapters {
  const httpRequests = input.meter.createCounter('surfgate.http.requests', {
    description: 'Completed SurfGate HTTP requests.',
  })
  const httpDuration = input.meter.createHistogram('surfgate.http.request.duration', {
    description: 'SurfGate HTTP request duration.',
    unit: 'ms',
  })
  const authAttempts = input.meter.createCounter('surfgate.auth.attempts')
  const dependencyReady = input.meter.createUpDownCounter('surfgate.dependency.ready')
  const dependencyDuration = input.meter.createHistogram('surfgate.dependency.health.duration', {
    unit: 'ms',
  })
  const sessionTransitions = input.meter.createCounter('surfgate.session.transitions')
  const activeSessions = input.meter.createUpDownCounter('surfgate.session.active')
  const operationAttempts = input.meter.createCounter('surfgate.operation.attempts')
  const operationDuration = input.meter.createHistogram('surfgate.operation.duration', {
    unit: 'ms',
  })
  const routingDecisions = input.meter.createCounter('surfgate.routing.decisions')
  const routingRejections = input.meter.createCounter('surfgate.routing.candidate_rejections')
  const relayConnections = input.meter.createCounter('surfgate.relay.connections')
  const relayActive = input.meter.createUpDownCounter('surfgate.relay.active_connections')
  const relayBytes = input.meter.createCounter('surfgate.relay.bytes', { unit: 'By' })
  const relayFrames = input.meter.createCounter('surfgate.relay.frames')
  const taskEvents = input.meter.createCounter('surfgate.task.events')
  const taskDuration = input.meter.createHistogram('surfgate.task.duration', { unit: 'ms' })
  const taskQueueDuration = input.meter.createHistogram('surfgate.task.queue.duration', {
    unit: 'ms',
  })
  const taskActive = input.meter.createUpDownCounter('surfgate.task.active')
  const artifactBytes = input.meter.createHistogram('surfgate.artifact.bytes', { unit: 'By' })
  let lastRelayActive = 0
  let lastTaskActive = 0
  const dependencyStates = new Map<string, number>()

  const startSpan: TelemetryAdapters['startSpan'] = (name, attributes = {}, parent) => {
    const parentContext = extractTraceContext(parent)
    const span = input.tracer.startSpan(
      name,
      { attributes: boundedAttributes(attributes) },
      parentContext,
    )
    const spanContext = trace.setSpan(parentContext, span)
    let ended = false
    return Object.freeze({
      run<Result>(operation: () => Result): Result {
        return context.with(spanContext, operation)
      },
      context(): TraceContextCarrier | undefined {
        return injectTraceContext(spanContext)
      },
      end(outcome: 'success' | 'failure', extra = {}): void {
        if (ended) return
        ended = true
        span.setAttributes(boundedAttributes(extra))
        span.setStatus({ code: outcome === 'failure' ? SpanStatusCode.ERROR : SpanStatusCode.OK })
        span.end()
      },
    })
  }

  const recordSpan = (
    name: string,
    attributes: Readonly<Record<string, unknown>>,
    durationMs = 0,
  ): void => endRecordedSpan(input.tracer, name, attributes, durationMs)
  const recordDependencyHealth = (observation: DependencyHealthObservation): void => {
    const labels = metricAttributes({ operation: observation.dependency })
    const durationLabels = metricAttributes({
      operation: observation.dependency,
      outcome: observation.status,
    })
    const current = observation.status === 'ready' ? 1 : 0
    const dependency = String(labels.operation ?? 'OTHER')
    const previous = dependencyStates.get(dependency) ?? 0
    dependencyReady.add(current - previous, labels)
    dependencyStates.set(dependency, current)
    dependencyDuration.record(observation.durationMs, durationLabels)
  }

  const controlPlane: ControlPlaneTelemetry = Object.freeze({
    startSpan,
    recordDependencyHealth,
    recordHTTP(observation: HTTPObservation): void {
      const labels = metricAttributes({
        method: observation.method,
        route: normalizeMetricRoute(observation.route),
        statusCode: observation.statusCode,
        outcome: observation.outcome,
      })
      httpRequests.add(1, labels)
      httpDuration.record(observation.durationMs, labels)
    },
    recordAuthentication(observation: AuthenticationObservation): void {
      const labels = metricAttributes({
        outcome: observation.outcome,
        reasonCode: observation.reason,
      })
      authAttempts.add(1, labels)
      recordSpan('surfgate.auth.verify', labels)
    },
    recordDatabaseHealth(status: 'ready' | 'unavailable'): void {
      recordDependencyHealth({ dependency: 'postgresql', status, durationMs: 0 })
    },
    recordSessionTransition(observation: SessionTransitionObservation): void {
      const labels = metricAttributes(observation)
      sessionTransitions.add(1, labels)
      if (observation.outcome === 'success') {
        if (observation.from !== 'active' && observation.to === 'active') activeSessions.add(1)
        if (observation.from === 'active' && observation.to !== 'active') activeSessions.add(-1)
      }
      recordSpan('surfgate.session.persist', labels)
    },
    recordRoutingDecision(observation: RoutingDecisionObservation): void {
      const labels = metricAttributes(observation)
      routingDecisions.add(1, labels)
      for (const reasonCode of new Set(observation.rejectedReasonCodes.slice(0, 32))) {
        routingRejections.add(1, metricAttributes({ reasonCode }))
      }
    },
    recordOperation(observation: ControlPlaneOperationObservation): void {
      const labels = metricAttributes(observation)
      operationAttempts.add(1, labels)
      operationDuration.record(observation.durationMs, labels)
      recordSpan(observation.operation, labels, observation.durationMs)
    },
  })

  const relay: RelayTelemetry = Object.freeze({
    startSpan,
    recordDependencyHealth,
    recordConnection(observation: RelayConnectionObservation): void {
      const labels = metricAttributes(observation)
      relayConnections.add(1, labels)
      const spanName =
        observation.event === 'auth_failure'
          ? 'surfgate.relay.authenticate'
          : observation.event === 'upstream_connect'
            ? 'surfgate.relay.upstream_connect'
            : 'surfgate.relay.connection'
      recordSpan(spanName, labels, observation.durationMs)
    },
    recordTraffic(observation: RelayTrafficObservation): void {
      const labels = metricAttributes({ direction: observation.direction })
      relayBytes.add(observation.bytes, labels)
      relayFrames.add(observation.frames, labels)
    },
    setActiveConnections(value: number): void {
      const normalized = Math.max(0, Math.trunc(value))
      relayActive.add(normalized - lastRelayActive)
      lastRelayActive = normalized
    },
  })

  const managedTasks: ManagedTaskTelemetry = Object.freeze({
    startSpan,
    recordDependencyHealth,
    captureTraceContext: injectTraceContext,
    recordTask(observation: ManagedTaskObservation): void {
      const labels = metricAttributes(observation)
      taskEvents.add(1, labels)
      taskDuration.record(observation.durationMs, labels)
      if (observation.queueLatencyMs !== undefined) {
        taskQueueDuration.record(observation.queueLatencyMs, labels)
      }
      if (observation.bytes !== undefined) artifactBytes.record(observation.bytes, labels)
      const spanName =
        observation.event === 'artifact_upload'
          ? 'surfgate.artifact.store'
          : observation.event === 'artifact_access'
            ? 'surfgate.artifact.access'
            : `surfgate.task.${observation.event}`
      recordSpan(spanName, labels, observation.durationMs)
    },
    setActiveTasks(value: number): void {
      const normalized = Math.max(0, Math.trunc(value))
      taskActive.add(normalized - lastTaskActive)
      lastTaskActive = normalized
    },
  })

  return Object.freeze({
    tracer: input.tracer,
    controlPlane,
    relay,
    managedTasks,
    startSpan,
    recordSpan,
  })
}
