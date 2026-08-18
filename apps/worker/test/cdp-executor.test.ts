import type { AddressInfo } from 'node:net'
import { once } from 'node:events'

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'

import { CDPManagedBrowserExecutor } from '../src/cdp-executor.js'

const servers: WebSocketServer[] = []

async function fakeCDP(
  handle: (message: Readonly<Record<string, unknown>>, socket: WebSocket) => void,
): Promise<string> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(server)
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const bytes = Buffer.isBuffer(data)
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.alloc(0)
      const parsed = JSON.parse(bytes.toString('utf8')) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        handle(parsed as Readonly<Record<string, unknown>>, socket)
      }
    })
  })
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  return `ws://127.0.0.1:${address.port}`
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate()
          server.close(() => resolve())
        }),
    ),
  )
})

describe('CDPManagedBrowserExecutor', () => {
  it('runs a fixed extraction expression and returns bounded title/text', async () => {
    let expression = ''
    const endpoint = await fakeCDP((message, socket) => {
      expression = String((message.params as Readonly<Record<string, unknown>>).expression)
      socket.send(
        JSON.stringify({
          id: message.id,
          result: { result: { value: { title: 'Example', text: 'selected text' } } },
        }),
      )
    })

    const result = await new CDPManagedBrowserExecutor().execute({
      request: { type: 'extract', selector: '#main' },
      connection: { endpoint, headers: {} },
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      maxScreenshotPixels: 33_554_432,
      signal: new AbortController().signal,
    })

    expect(result).toEqual({ type: 'extract', title: 'Example', text: 'selected text' })
    expect(expression).toContain('document.querySelector')
    expect(expression).toContain('"#main"')
  })

  it.each([
    ['screenshot', 'Page.captureScreenshot', 'image/png'] as const,
    ['pdf', 'Page.printToPDF', 'application/pdf'] as const,
  ])('returns bounded %s binary output', async (type, method, mediaType) => {
    const endpoint = await fakeCDP((message, socket) => {
      if (type === 'screenshot' && message.method === 'Page.getLayoutMetrics') {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { cssVisualViewport: { clientWidth: 1_280, clientHeight: 720 } },
          }),
        )
        return
      }
      expect(message.method).toBe(method)
      socket.send(JSON.stringify({ id: message.id, result: { data: 'AQID' } }))
    })

    const result = await new CDPManagedBrowserExecutor().execute({
      request: type === 'screenshot' ? { type, format: 'png' } : { type },
      connection: { endpoint, headers: {} },
      timeoutMs: 1_000,
      maxOutputBytes: 100,
      maxScreenshotPixels: 33_554_432,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ type, mediaType })
    if (result.type === 'extract') throw new Error('Expected binary task output.')
    expect(Array.from(result.bytes)).toEqual([1, 2, 3])
  })

  it('rejects oversized output, cancellation, and timeout with stable codes', async () => {
    const oversizedEndpoint = await fakeCDP((message, socket) => {
      socket.send(JSON.stringify({ id: message.id, result: { data: 'AQIDBA==' } }))
    })
    await expect(
      new CDPManagedBrowserExecutor().execute({
        request: { type: 'pdf' },
        connection: { endpoint: oversizedEndpoint, headers: {} },
        timeoutMs: 1_000,
        maxOutputBytes: 3,
        maxScreenshotPixels: 33_554_432,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'TASK_OUTPUT_TOO_LARGE' })

    const controller = new AbortController()
    const cancelledEndpoint = await fakeCDP(() => controller.abort())
    await expect(
      new CDPManagedBrowserExecutor().execute({
        request: { type: 'extract' },
        connection: { endpoint: cancelledEndpoint, headers: {} },
        timeoutMs: 1_000,
        maxOutputBytes: 100,
        maxScreenshotPixels: 33_554_432,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'TASK_CANCELLED', retryable: false })

    const timeoutController = new AbortController()
    const timeoutEndpoint = await fakeCDP(() =>
      timeoutController.abort(new DOMException('Timed out', 'TimeoutError')),
    )
    await expect(
      new CDPManagedBrowserExecutor().execute({
        request: { type: 'extract' },
        connection: { endpoint: timeoutEndpoint, headers: {} },
        timeoutMs: 1_000,
        maxOutputBytes: 100,
        maxScreenshotPixels: 33_554_432,
        signal: timeoutController.signal,
      }),
    ).rejects.toMatchObject({ code: 'TASK_TIMEOUT', retryable: true })
  })

  it('rejects a full-page screenshot whose pixel area exceeds the safe ceiling', async () => {
    const endpoint = await fakeCDP((message, socket) => {
      if (message.method === 'Page.getLayoutMetrics') {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { cssContentSize: { width: 8_192, height: 8_192 } },
          }),
        )
        return
      }
      socket.send(JSON.stringify({ id: message.id, result: { data: 'AQID' } }))
    })

    await expect(
      new CDPManagedBrowserExecutor().execute({
        request: { type: 'screenshot', fullPage: true },
        connection: { endpoint, headers: {} },
        timeoutMs: 1_000,
        maxOutputBytes: 100,
        maxScreenshotPixels: 33_554_432,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'TASK_OUTPUT_TOO_LARGE' })
  })

  it('rejects a non-full-page screenshot whose current viewport exceeds the safe ceiling', async () => {
    const endpoint = await fakeCDP((message, socket) => {
      if (message.method === 'Page.getLayoutMetrics') {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { cssVisualViewport: { clientWidth: 8_192, clientHeight: 8_192 } },
          }),
        )
        return
      }
      socket.send(JSON.stringify({ id: message.id, result: { data: 'AQID' } }))
    })

    await expect(
      new CDPManagedBrowserExecutor().execute({
        request: { type: 'screenshot', fullPage: false },
        connection: { endpoint, headers: {} },
        timeoutMs: 1_000,
        maxOutputBytes: 100,
        maxScreenshotPixels: 33_554_432,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'TASK_OUTPUT_TOO_LARGE' })
  })
})
