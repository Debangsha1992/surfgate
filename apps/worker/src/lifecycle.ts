import { settleOperation, type BoundedOperationResult } from '@surfgate/observability'

const ABORTED = Symbol('worker-aborted')

/**
 * Normal work is not constrained by the shutdown drain timeout. Once shutdown
 * starts, however, a misbehaving executor cannot indefinitely block service
 * cleanup and telemetry flush.
 */
export async function awaitWorkerOperation<Result>(
  operation: Promise<Result>,
  shutdownSignal: AbortSignal,
  drainTimeoutMs: number,
): Promise<BoundedOperationResult<Result>> {
  const settled = operation.then(
    (value) => ({ kind: 'completed' as const, value }),
    () => ({ kind: 'failed' as const }),
  )
  if (!shutdownSignal.aborted) {
    let abortListener: (() => void) | undefined
    const aborted = new Promise<typeof ABORTED>((resolve) => {
      abortListener = () => resolve(ABORTED)
      shutdownSignal.addEventListener('abort', abortListener, { once: true })
    })
    const first = await Promise.race([settled, aborted])
    if (abortListener !== undefined) shutdownSignal.removeEventListener('abort', abortListener)
    if (first !== ABORTED) return first
  }
  return settleOperation(operation, drainTimeoutMs)
}

type WorkerShutdownDependencies = Readonly<{
  activeOperationTimedOut: boolean
  drainTimeoutMs: number
  closeHealth(): Promise<void>
  closeDatabase(): Promise<void>
  shutdownTelemetry(): Promise<void>
  forceExit(code: number): void
  warn(event: 'worker.shutdown.dependency_timeout' | 'worker.shutdown.forced'): void
}>

/**
 * A timed-out task may still own sockets even after ignoring its AbortSignal.
 * In that case the only reliable Node process boundary is a forced exit after
 * the bounded telemetry flush. Graceful dependency closure is reserved for
 * the path where active work has actually settled.
 */
export async function completeWorkerShutdown(
  dependencies: WorkerShutdownDependencies,
): Promise<void> {
  if (dependencies.activeOperationTimedOut) {
    dependencies.warn('worker.shutdown.forced')
    await dependencies.shutdownTelemetry()
    dependencies.forceExit(1)
    return
  }

  const closures = await Promise.all([
    settleOperation(dependencies.closeHealth(), dependencies.drainTimeoutMs),
    settleOperation(dependencies.closeDatabase(), dependencies.drainTimeoutMs),
  ])
  const dependencyClosureFailed = closures.some((result) => result.kind !== 'completed')
  if (dependencyClosureFailed) dependencies.warn('worker.shutdown.dependency_timeout')
  await dependencies.shutdownTelemetry()
  if (dependencyClosureFailed) dependencies.forceExit(1)
}
