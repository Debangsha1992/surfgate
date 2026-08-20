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
