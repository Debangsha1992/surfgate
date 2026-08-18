import {
  ManagedTaskExecutionError,
  type ManagedBrowserExecutor,
  type TaskExecutionOutput,
} from '@surfgate/task-core'
import WebSocket, { type RawData } from 'ws'

function rawBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  throw new ManagedTaskExecutionError('TASK_EXECUTION_FAILED', false)
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function cancellationError(signal: AbortSignal): ManagedTaskExecutionError {
  const timedOut = signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
  return new ManagedTaskExecutionError(timedOut ? 'TASK_TIMEOUT' : 'TASK_CANCELLED', timedOut)
}

function connect(
  endpoint: string,
  headers: Readonly<{ Authorization?: string | undefined }>,
  timeoutMs: number,
  maxPayload: number,
  signal: AbortSignal,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      headers,
      handshakeTimeout: timeoutMs,
      followRedirects: false,
      maxPayload,
      perMessageDeflate: false,
    })
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', aborted)
      if (error === undefined) resolve(socket)
      else {
        socket.terminate()
        reject(error)
      }
    }
    const aborted = (): void => finish(cancellationError(signal))
    if (signal.aborted) {
      aborted()
      return
    }
    signal.addEventListener('abort', aborted, { once: true })
    socket.once('open', () => finish())
    socket.once('error', () => finish(new ManagedTaskExecutionError('TASK_EXECUTION_FAILED', true)))
  })
}

async function command(
  socket: WebSocket,
  id: number,
  method: string,
  params: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.off('message', message)
      socket.off('close', closed)
      signal.removeEventListener('abort', aborted)
    }
    const aborted = (): void => {
      cleanup()
      reject(cancellationError(signal))
    }
    const closed = (): void => {
      cleanup()
      reject(new ManagedTaskExecutionError('TASK_EXECUTION_FAILED', true))
    }
    const message = (data: RawData): void => {
      try {
        const parsed = JSON.parse(rawBuffer(data).toString('utf8')) as unknown
        const response = object(parsed)
        if (response?.id !== id) return
        cleanup()
        if (response.error !== undefined)
          reject(new ManagedTaskExecutionError('TASK_EXECUTION_FAILED', false))
        else resolve(response.result)
      } catch {
        cleanup()
        reject(new ManagedTaskExecutionError('TASK_EXECUTION_FAILED', false))
      }
    }
    if (signal.aborted) {
      aborted()
      return
    }
    signal.addEventListener('abort', aborted, { once: true })
    socket.once('close', closed)
    socket.on('message', message)
    socket.send(JSON.stringify({ id, method, params }), (error) => {
      if (error instanceof Error) closed()
    })
  })
}
function decodedBase64(value: unknown, maxBytes: number): Uint8Array {
  if (typeof value !== 'string') throw new ManagedTaskExecutionError('TASK_EXECUTION_FAILED', false)
  if (value.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    throw new ManagedTaskExecutionError('TASK_OUTPUT_TOO_LARGE', false)
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new ManagedTaskExecutionError('TASK_EXECUTION_FAILED', false)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength > maxBytes)
    throw new ManagedTaskExecutionError('TASK_OUTPUT_TOO_LARGE', false)
  return bytes
}

export class CDPManagedBrowserExecutor implements ManagedBrowserExecutor {
  async execute(
    input: Parameters<ManagedBrowserExecutor['execute']>[0],
  ): Promise<TaskExecutionOutput> {
    const socket = await connect(
      input.connection.endpoint,
      input.connection.headers,
      input.timeoutMs,
      Math.min(64 * 1_024 * 1_024, input.maxOutputBytes * 2 + 65_536),
      input.signal,
    )
    try {
      if (input.request.type === 'extract') {
        const selector = JSON.stringify(input.request.selector ?? null)
        const expression = `(() => { const s=${selector}; const n=s===null?document.body:document.querySelector(s); return {title:String(document.title||''),text:String(n?.textContent||'')}; })()`
        const result = object(
          await command(
            socket,
            1,
            'Runtime.evaluate',
            { expression, returnByValue: true, awaitPromise: true },
            input.signal,
          ),
        )
        const remote = object(result?.result)
        const value = object(remote?.value)
        if (typeof value?.title !== 'string' || typeof value.text !== 'string')
          throw new ManagedTaskExecutionError('TASK_EXECUTION_FAILED', false)
        return { type: 'extract', title: value.title, text: value.text }
      }
      if (input.request.type === 'screenshot') {
        const metrics = object(await command(socket, 1, 'Page.getLayoutMetrics', {}, input.signal))
        const viewport =
          input.request.fullPage === true
            ? object(metrics?.cssContentSize)
            : object(metrics?.cssVisualViewport)
        const width = input.request.fullPage === true ? viewport?.width : viewport?.clientWidth
        const height = input.request.fullPage === true ? viewport?.height : viewport?.clientHeight
        if (
          typeof width !== 'number' ||
          typeof height !== 'number' ||
          !Number.isFinite(width) ||
          !Number.isFinite(height) ||
          width <= 0 ||
          height <= 0 ||
          width > 16_384 ||
          height > 65_536 ||
          width * height > input.maxScreenshotPixels
        ) {
          throw new ManagedTaskExecutionError('TASK_OUTPUT_TOO_LARGE', false)
        }
        let clip: Readonly<Record<string, unknown>> | undefined
        if (input.request.fullPage === true) {
          clip = { x: 0, y: 0, width, height, scale: 1 }
        }
        const result = object(
          await command(
            socket,
            2,
            'Page.captureScreenshot',
            {
              format: input.request.format ?? 'png',
              ...(input.request.quality === undefined ? {} : { quality: input.request.quality }),
              captureBeyondViewport: input.request.fullPage ?? false,
              ...(clip === undefined ? {} : { clip }),
            },
            input.signal,
          ),
        )
        return {
          type: 'screenshot',
          mediaType: (input.request.format ?? 'png') === 'jpeg' ? 'image/jpeg' : 'image/png',
          bytes: decodedBase64(result?.data, input.maxOutputBytes),
        }
      }
      const result = object(
        await command(
          socket,
          1,
          'Page.printToPDF',
          {
            landscape: input.request.landscape ?? false,
            printBackground: input.request.printBackground ?? true,
            ...(input.request.widthInches === undefined
              ? {}
              : { paperWidth: input.request.widthInches }),
            ...(input.request.heightInches === undefined
              ? {}
              : { paperHeight: input.request.heightInches }),
          },
          input.signal,
        ),
      )
      return {
        type: 'pdf',
        mediaType: 'application/pdf',
        bytes: decodedBase64(result?.data, input.maxOutputBytes),
      }
    } finally {
      // A provider that does not finish the close handshake must not retain a worker socket.
      socket.terminate()
    }
  }
}
