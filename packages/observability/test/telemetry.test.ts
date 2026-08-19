import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createStructuredLogger,
  createTelemetryAdapters,
  createTelemetryRuntime,
  extractTraceContext,
  injectTraceContext,
  normalizeMetricRoute,
  settleTelemetryShutdown,
  type TelemetryAdapters,
} from '../src/index.js'

type Harness = Readonly<{
  adapters: TelemetryAdapters
  spans: InMemorySpanExporter
  metrics: InMemoryMetricExporter
  tracerProvider: BasicTracerProvider
  meterProvider: MeterProvider
}>

const harnesses: Harness[] = []

function createHarness(): Harness {
  const spans = new InMemorySpanExporter()
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spans)],
  })
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metrics,
    exportIntervalMillis: 60_000,
  })
  const meterProvider = new MeterProvider({ readers: [metricReader] })
  const adapters = createTelemetryAdapters({
    serviceName: 'surfgate-api',
    tracer: tracerProvider.getTracer('test'),
    meter: meterProvider.getMeter('test'),
  })
  const harness = { adapters, spans, metrics, tracerProvider, meterProvider }
  harnesses.push(harness)
  return harness
}

function metricSeriesCounts(metrics: InMemoryMetricExporter): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const resource of metrics.getMetrics()) {
    for (const scope of resource.scopeMetrics) {
      for (const metric of scope.metrics) {
        counts.set(
          metric.descriptor.name,
          (counts.get(metric.descriptor.name) ?? 0) + metric.dataPoints.length,
        )
      }
    }
  }
  return counts
}

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(async ({ tracerProvider, meterProvider }) => {
      await tracerProvider.shutdown()
      await meterProvider.shutdown()
    }),
  )
})

describe('production telemetry adapters', () => {
  it('emits bounded HTTP metrics and a core request span using a route template', async () => {
    const { adapters, spans, metrics, meterProvider } = createHarness()

    adapters.controlPlane.recordHTTP({
      method: 'GET',
      route: '/v1/sessions/:sessionId',
      statusCode: 200,
      durationMs: 12,
      outcome: 'success',
    })
    adapters
      .startSpan('surfgate.http.request', { method: 'GET', route: '/v1/sessions/:sessionId' })
      .end('success')
    await meterProvider.forceFlush()

    expect(spans.getFinishedSpans()).toEqual([
      expect.objectContaining({ name: 'surfgate.http.request' }),
    ])
    const serialized = JSON.stringify(metrics.getMetrics())
    expect(serialized).toContain('surfgate.http.requests')
    expect(serialized).toContain('/v1/sessions/:sessionId')
    expect(serialized).not.toContain('ses_01JEXAMPLE')
  })

  it('keeps local telemetry backend-free and bounds shutdown', async () => {
    const runtime = createTelemetryRuntime(
      {
        endpoint: undefined,
        serviceName: 'surfgate',
        exportIntervalMs: 10_000,
        exportTimeoutMs: 5_000,
        shutdownTimeoutMs: 10,
        maxQueueSize: 64,
        maxExportBatchSize: 16,
        metricCardinalityLimit: 32,
      },
      'worker',
    )

    expect(runtime.enabled).toBe(false)
    await expect(runtime.shutdown()).resolves.toBeUndefined()
    await expect(settleTelemetryShutdown(new Promise<void>(() => undefined), 5)).resolves.toBe(
      'timed_out',
    )
  })

  it('redacts structured logs and includes safe trace correlation', () => {
    const { adapters } = createHarness()
    const lines: string[] = []
    const logger = createStructuredLogger({
      service: 'surfgate-worker',
      environment: 'test',
      write: (line) => lines.push(line),
    })
    const parent = adapters.tracer.startSpan('parent')

    context.with(trace.setSpan(context.active(), parent), () => {
      logger.warn(
        {
          event: 'task.failed',
          authorization: 'Bearer secret',
          nested: { cookie: 'session=secret' },
        },
        'Task failed with Bearer message-secret',
      )
    })
    parent.end()

    const serialized = lines.join('\n')
    expect(serialized).toContain('surfgate-worker')
    expect(serialized).toContain('task.failed')
    expect(serialized).not.toContain('Bearer secret')
    expect(serialized).not.toContain('session=secret')
    expect(serialized).not.toContain('message-secret')
  })

  it('drops high-cardinality and secret-bearing attributes before export', () => {
    const { adapters, spans } = createHarness()

    adapters.recordSpan('surfgate.task.execute', {
      outcome: 'failure',
      taskType: 'extract',
      policyVersion: 'router-v1',
      tenantID: 'ten_secret',
      sessionID: 'ses_secret',
      targetURL: 'https://secret.example',
      authorization: 'Bearer secret',
    })

    const exported = JSON.stringify(spans.getFinishedSpans().map((span) => span.attributes))
    expect(exported).toContain('taskType')
    expect(exported).toContain('router-v1')
    expect(exported).not.toContain('ten_secret')
    expect(exported).not.toContain('ses_secret')
    expect(exported).not.toContain('secret.example')
    expect(exported).not.toContain('Bearer secret')
  })

  it('never turns a raw resource path into a metric label', () => {
    expect(normalizeMetricRoute('/v1/sessions/ses_00000000000000000000000000')).toBe('unmatched')
    expect(normalizeMetricRoute('/v1/sessions/:sessionId')).toBe('/v1/sessions/:sessionId')
  })

  it('collapses high-cardinality raw paths into one bounded metric series', async () => {
    const { adapters, metrics, meterProvider } = createHarness()
    for (let index = 0; index < 500; index += 1) {
      adapters.controlPlane.recordHTTP({
        method: 'GET',
        route: `/v1/sessions/ses_${index.toString().padStart(26, '0')}`,
        statusCode: 404,
        durationMs: 1,
        outcome: 'success',
      })
    }
    await meterProvider.forceFlush()

    const serialized = JSON.stringify(metrics.getMetrics())
    expect(serialized).toContain('unmatched')
    expect(serialized).not.toContain('ses_00000000000000000000000001')
  })

  it('bounds metric series when callers supply thousands of unique resource identities', async () => {
    const { adapters, metrics, meterProvider } = createHarness()

    for (let index = 0; index < 1_000; index += 1) {
      const identity = index.toString().padStart(26, '0')
      adapters.controlPlane.recordHTTP({
        method: 'GET',
        route: `/v1/sessions/ses_${identity}`,
        statusCode: 404,
        durationMs: 1,
        outcome: 'success',
      })
      adapters.controlPlane.recordAuthentication({
        outcome: 'failure',
        reason: `req_${identity}`,
      })
      adapters.controlPlane.recordSessionTransition({
        from: `ses_${identity}`,
        to: `ten_${identity}`,
        outcome: 'conflict',
      })
      adapters.controlPlane.recordRoutingDecision?.({
        outcome: 'selected',
        policyVersion: `tenant_${identity}`,
        runtimeClass: `session_${identity}`,
        providerID: `request_${identity}`,
        rejectedReasonCodes: [`task_${identity}`],
      })
      adapters.controlPlane.recordOperation?.({
        operation: 'surfgate.provider.allocate',
        outcome: 'failure',
        durationMs: 1,
        runtimeClass: `runtime_${identity}`,
        providerID: `provider_${identity}`,
        policyVersion: `policy_${identity}`,
        reasonCode: `artifact_${identity}`,
      })
      adapters.relay.recordConnection({
        event: 'close',
        outcome: 'failure',
        runtimeClass: `runtime_${identity}`,
        providerID: `provider_${identity}`,
        reasonCode: `connection_${identity}`,
      })
      adapters.managedTasks.recordTask({
        event: 'execute',
        taskType: 'extract',
        outcome: 'failure',
        durationMs: 1,
        attemptCount: index,
        reasonCode: `task_${identity}`,
      })
    }
    adapters.controlPlane.recordOperation?.({
      operation: 'surfgate.provider.allocate',
      outcome: 'failure',
      durationMs: 1,
      runtimeClass: 'chromium',
      providerID: 'cloudflare-browser-run',
      policyVersion: 'router-v1',
      reasonCode: 'PROVIDER_OPERATION_TIMEOUT',
    })
    adapters.relay.recordConnection({
      event: 'close',
      outcome: 'failure',
      reasonCode: 'UPSTREAM_CLOSED',
    })
    adapters.managedTasks.recordTask({
      event: 'retry',
      taskType: 'pdf',
      outcome: 'success',
      durationMs: 1,
      attemptCount: 2,
      reasonCode: 'TASK_TIMEOUT',
    })
    await meterProvider.forceFlush()

    const counts = metricSeriesCounts(metrics)
    for (const [metric, count] of counts) {
      expect(count, `${metric} created too many identity-derived series`).toBeLessThanOrEqual(32)
    }
    expect(counts.get('surfgate.auth.attempts')).toBe(1)
    expect(counts.get('surfgate.session.transitions')).toBe(1)
    expect(counts.get('surfgate.routing.decisions')).toBe(1)
    expect(counts.get('surfgate.routing.candidate_rejections')).toBe(1)
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(12)
    const serialized = JSON.stringify(metrics.getMetrics())
    expect(serialized).toContain('cloudflare-browser-run')
    expect(serialized).toContain('PROVIDER_OPERATION_TIMEOUT')
    expect(serialized).toContain('UPSTREAM_CLOSED')
    expect(serialized).toContain('TASK_TIMEOUT')
    expect(serialized).not.toMatch(
      /(ses|ten|req|task|artifact|provider|runtime|policy|connection)_00000000000000000000000001/u,
    )
  })

  it('propagates W3C trace context without persisting baggage or arbitrary headers', () => {
    const { adapters } = createHarness()
    const parent = adapters.tracer.startSpan('parent')
    const carrier = injectTraceContext(trace.setSpan(context.active(), parent))
    parent.end()

    expect(carrier?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/u)
    const extracted = extractTraceContext(carrier)
    expect(trace.getSpanContext(extracted)?.traceId).toBe(parent.spanContext().traceId)
  })

  it('preserves trace correlation across an asynchronous service boundary', async () => {
    const manager = new AsyncLocalStorageContextManager().enable()
    expect(context.setGlobalContextManager(manager)).toBe(true)
    const { adapters } = createHarness()
    const span = adapters.startSpan('surfgate.task.create')

    const observed = await span.run(async () => {
      await Promise.resolve()
      return injectTraceContext()
    })
    span.end('success')

    expect(observed?.traceparent).toBe(span.context()?.traceparent)
    manager.disable()
    context.disable()
  })
})
