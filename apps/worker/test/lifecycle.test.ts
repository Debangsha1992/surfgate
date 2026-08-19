import { describe, expect, it } from 'vitest'

import { awaitWorkerOperation, completeWorkerShutdown } from '../src/lifecycle.js'

describe('worker lifecycle bounds', () => {
  it('allows normal work to finish before shutdown begins', async () => {
    const controller = new AbortController()

    await expect(
      awaitWorkerOperation(Promise.resolve(true), controller.signal, 5),
    ).resolves.toEqual({ kind: 'completed', value: true })
  })

  it('bounds work that ignores an already-started shutdown', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      awaitWorkerOperation(new Promise<boolean>(() => undefined), controller.signal, 5),
    ).resolves.toEqual({ kind: 'timed_out' })
  })

  it('forces process termination when active work ignored cancellation', async () => {
    const events: string[] = []

    await completeWorkerShutdown({
      activeOperationTimedOut: true,
      drainTimeoutMs: 5,
      closeHealth: () => new Promise<void>(() => undefined),
      closeDatabase: () => new Promise<void>(() => undefined),
      shutdownTelemetry: () => {
        events.push('telemetry')
        return Promise.resolve()
      },
      forceExit: (code) => events.push(`exit:${code}`),
      warn: (event) => events.push(event),
    })

    expect(events).toEqual(['worker.shutdown.forced', 'telemetry', 'exit:1'])
  })

  it('forces process termination when dependency closure misses its deadline', async () => {
    const events: string[] = []

    await completeWorkerShutdown({
      activeOperationTimedOut: false,
      drainTimeoutMs: 5,
      closeHealth: () => Promise.resolve(),
      closeDatabase: () => new Promise<void>(() => undefined),
      shutdownTelemetry: () => {
        events.push('telemetry')
        return Promise.resolve()
      },
      forceExit: (code) => events.push(`exit:${code}`),
      warn: (event) => events.push(event),
    })

    expect(events).toEqual(['worker.shutdown.dependency_timeout', 'telemetry', 'exit:1'])
  })
})
