import { metrics, trace } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { AggregationType, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { TelemetryConfig } from '@surfgate/config'

import { createTelemetryAdapters, type TelemetryAdapters } from './telemetry.js'

export type ServiceComponent = 'api' | 'relay' | 'worker'

export type TelemetryRuntime = TelemetryAdapters &
  Readonly<{
    enabled: boolean
    serviceName: string
    shutdown(): Promise<void>
  }>

export type BoundedOperationResult<Result> =
  | Readonly<{ kind: 'completed'; value: Result }>
  | Readonly<{ kind: 'failed' }>
  | Readonly<{ kind: 'timed_out' }>

function signalURL(endpoint: URL, signal: 'traces' | 'metrics'): string {
  return `${endpoint.href.replace(/\/$/u, '')}/v1/${signal}`
}

export async function settleOperation<Result>(
  operation: Promise<Result>,
  timeoutMs: number,
): Promise<BoundedOperationResult<Result>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation.then(
        (value) => ({ kind: 'completed' as const, value }),
        () => ({ kind: 'failed' as const }),
      ),
      new Promise<Readonly<{ kind: 'timed_out' }>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timed_out' }), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function settleTelemetryShutdown(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<'completed' | 'timed_out'> {
  const result = await settleOperation(operation, timeoutMs)
  return result.kind === 'timed_out' ? 'timed_out' : 'completed'
}

export function createTelemetryRuntime(
  config: TelemetryConfig,
  component: ServiceComponent,
): TelemetryRuntime {
  const serviceName = `${config.serviceName}-${component}`
  let sdk: NodeSDK | undefined
  if (config.endpoint !== undefined) {
    const traceExporter = new OTLPTraceExporter({
      url: signalURL(config.endpoint, 'traces'),
      timeoutMillis: config.exportTimeoutMs,
      concurrencyLimit: 1,
    })
    const metricExporter = new OTLPMetricExporter({
      url: signalURL(config.endpoint, 'metrics'),
      timeoutMillis: config.exportTimeoutMs,
      concurrencyLimit: 1,
    })
    sdk = new NodeSDK({
      autoDetectResources: false,
      resource: resourceFromAttributes({ 'service.name': serviceName }),
      views: [
        {
          instrumentName: 'surfgate.*.duration',
          aggregationCardinalityLimit: config.metricCardinalityLimit,
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: {
              boundaries: [
                5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000,
              ],
              recordMinMax: true,
            },
          },
        },
        {
          instrumentName: 'surfgate.artifact.bytes',
          aggregationCardinalityLimit: config.metricCardinalityLimit,
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: {
              boundaries: [
                1_024, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216, 67_108_864,
              ],
              recordMinMax: true,
            },
          },
        },
      ],
      spanProcessors: [
        new BatchSpanProcessor(traceExporter, {
          maxQueueSize: config.maxQueueSize,
          maxExportBatchSize: config.maxExportBatchSize,
          exportTimeoutMillis: config.exportTimeoutMs,
          scheduledDelayMillis: Math.min(config.exportIntervalMs, 5_000),
        }),
      ],
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: config.exportIntervalMs,
          exportTimeoutMillis: config.exportTimeoutMs,
          maxExportBatchSize: config.maxExportBatchSize,
          cardinalityLimits: { default: config.metricCardinalityLimit },
        }),
      ],
    })
    sdk.start()
  }
  const adapters = createTelemetryAdapters({
    serviceName,
    tracer: trace.getTracer('surfgate'),
    meter: metrics.getMeter('surfgate'),
  })
  let shutdownPromise: Promise<void> | undefined
  return Object.freeze({
    ...adapters,
    enabled: sdk !== undefined,
    serviceName,
    shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        if (sdk === undefined) return
        await settleTelemetryShutdown(sdk.shutdown(), config.shutdownTimeoutMs)
      })()
      return shutdownPromise
    },
  })
}
