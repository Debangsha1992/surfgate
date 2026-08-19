import { settleOperation } from '@surfgate/observability'

type RelayShutdownDependencies = Readonly<{
  drainTimeoutMs: number
  closeServer(): Promise<void>
  closeDatabase(): Promise<void>
  shutdownTelemetry(): Promise<void>
  forceExit(code: number): void
  warn(): void
}>

/**
 * The relay server owns its bounded transport drain. Await it before flushing
 * telemetry so final close/backpressure observations cannot be emitted after
 * the OpenTelemetry SDK has shut down. Database closure remains independently
 * bounded; any failed resource closure requires a forced process boundary.
 */
export async function completeRelayShutdown(
  dependencies: RelayShutdownDependencies,
): Promise<void> {
  const serverClosure = await dependencies.closeServer().then(
    () => 'completed' as const,
    () => 'failed' as const,
  )
  const databaseClosure = await settleOperation(
    dependencies.closeDatabase(),
    dependencies.drainTimeoutMs,
  )
  const forceExit = serverClosure !== 'completed' || databaseClosure.kind !== 'completed'
  if (forceExit) dependencies.warn()
  await dependencies.shutdownTelemetry()
  if (forceExit) dependencies.forceExit(1)
}
