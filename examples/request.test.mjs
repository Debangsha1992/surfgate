import assert from 'node:assert/strict'
import test from 'node:test'

import { request } from './request.mjs'

test('reports the operation and configured duration when an HTTP request times out', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new DOMException('The operation timed out.', 'TimeoutError')
  }
  try {
    await assert.rejects(request('Task read', 'https://example.com/', {}, 5), {
      message: 'Task read timed out after 5 ms.',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('preserves caller cancellation', async () => {
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  globalThis.fetch = async (_input, init) => {
    controller.abort(new Error('cancelled by caller'))
    if (!init.signal.aborted) throw new Error('caller signal was not preserved')
    throw init.signal.reason
  }
  try {
    await assert.rejects(
      request('Session creation', 'https://example.com/', { signal: controller.signal }),
      /cancelled by caller/u,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
