import { describe, expect, it } from 'vitest'

import { completeRelayShutdown } from '../src/lifecycle.js'

describe('relay process lifecycle', () => {
  it('flushes telemetry only after the relay drain completes', async () => {
    const events: string[] = []
    let finishRelayDrain: (() => void) | undefined
    const relayDrain = new Promise<void>((resolve) => {
      finishRelayDrain = resolve
    })
    const shutdown = completeRelayShutdown({
      drainTimeoutMs: 5,
      closeServer: async () => {
        await relayDrain
        events.push('relay')
      },
      closeDatabase: () => {
        events.push('database')
        return Promise.resolve()
      },
      shutdownTelemetry: () => {
        events.push('telemetry')
        return Promise.resolve()
      },
      forceExit: (code) => events.push(`exit:${code}`),
      warn: () => events.push('warn'),
    })

    await Promise.resolve()
    expect(events).toEqual([])
    finishRelayDrain?.()
    await shutdown
    expect(events).toEqual(['relay', 'database', 'telemetry'])
  })

  it('forces the process boundary after a failed resource closure and telemetry flush', async () => {
    const events: string[] = []

    await completeRelayShutdown({
      drainTimeoutMs: 5,
      closeServer: () => Promise.reject(new Error('synthetic close failure')),
      closeDatabase: () => Promise.resolve(),
      shutdownTelemetry: () => {
        events.push('telemetry')
        return Promise.resolve()
      },
      forceExit: (code) => events.push(`exit:${code}`),
      warn: () => events.push('warn'),
    })

    expect(events).toEqual(['warn', 'telemetry', 'exit:1'])
  })
})
