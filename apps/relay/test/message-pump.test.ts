import { describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import WebSocket, { WebSocketServer, type RawData } from 'ws'

import { BoundedMessagePump, RelayStreamLimitError, type PumpSocket } from '../src/index.js'

class FakeSocket implements PumpSocket {
  bufferedAmount = 0
  readonly sent: Array<{ data: Buffer; binary: boolean }> = []
  readonly callbacks: Array<(error?: Error) => void> = []
  readonly pause = vi.fn()
  readonly resume = vi.fn()

  send(
    data: Buffer,
    options: Readonly<{ binary: boolean }>,
    callback: (error?: Error) => void,
  ): void {
    this.sent.push({ data, binary: options.binary })
    this.callbacks.push(callback)
  }
}

describe('BoundedMessagePump', () => {
  it('preserves ordering and pauses until a slow destination drains', () => {
    const source = new FakeSocket()
    const target = new FakeSocket()
    const pump = new BoundedMessagePump(source, target, {
      maxMessageBytes: 32,
      maxQueuedBytes: 64,
    })
    pump.enqueue(Buffer.from('one'), false)
    pump.enqueue(Buffer.from('two'), true)

    expect(target.sent.map(({ data }) => data.toString())).toEqual(['one'])
    expect(source.pause).toHaveBeenCalled()
    target.callbacks.shift()?.()
    expect(target.sent.map(({ data }) => data.toString())).toEqual(['one', 'two'])
    target.callbacks.shift()?.()
    expect(source.resume).toHaveBeenCalled()
  })

  it('rejects oversized frames and bounded-queue exhaustion deterministically', () => {
    const source = new FakeSocket()
    const target = new FakeSocket()
    const onLimit = vi.fn()
    const pump = new BoundedMessagePump(
      source,
      target,
      { maxMessageBytes: 4, maxQueuedBytes: 6 },
      onLimit,
    )

    expect(captureLimit(() => pump.enqueue(Buffer.from('12345'), false)).code).toBe(
      'MESSAGE_TOO_LARGE',
    )
    pump.enqueue(Buffer.from('1234'), false)
    expect(captureLimit(() => pump.enqueue(Buffer.from('5678'), false)).code).toBe(
      'BACKPRESSURE_LIMIT',
    )
    expect(onLimit).toHaveBeenCalledTimes(2)
  })

  it('normalizes destination transport send failures', () => {
    const target = new FakeSocket()
    const onFailure = vi.fn()
    const pump = new BoundedMessagePump(
      new FakeSocket(),
      target,
      { maxMessageBytes: 32, maxQueuedBytes: 64 },
      onFailure,
    )
    pump.enqueue(Buffer.from('message'), false)

    target.callbacks.shift()?.(new Error('synthetic transport failure'))

    expect(onFailure).toHaveBeenCalledWith('UPSTREAM_CLOSED')
  })

  it('resumes a paused source when closing with an in-flight send', () => {
    const source = new FakeSocket()
    const target = new FakeSocket()
    const pump = new BoundedMessagePump(source, target, {
      maxMessageBytes: 32,
      maxQueuedBytes: 64,
    })
    pump.enqueue(Buffer.from('one'), false)
    pump.enqueue(Buffer.from('two'), false)
    expect(source.pause).toHaveBeenCalledOnce()

    pump.close()

    expect(source.resume).toHaveBeenCalledOnce()
    expect(() => target.callbacks.shift()?.()).not.toThrow()
  })

  it('delivers through real WebSocket transports', async () => {
    const http = createServer()
    const wss = new WebSocketServer({ server: http })
    http.listen(0, '127.0.0.1')
    await waitListening(http)
    const address = http.address()
    if (address === null || typeof address === 'string') throw new Error('missing address')
    const accepted = waitConnection(wss)
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
    const serverSocket = await accepted
    await waitOpen(client)
    const message = waitMessage(client)
    const pump = new BoundedMessagePump(serverSocket, serverSocket, {
      maxMessageBytes: 32,
      maxQueuedBytes: 64,
    })
    pump.enqueue(Buffer.from('hello'), false)
    const { data } = await message
    expect(data.toString()).toBe('hello')
    client.terminate()
    serverSocket.terminate()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })

  it('bridges two independent real WebSocket connections', async () => {
    const leftHTTP = createServer()
    const rightHTTP = createServer()
    const leftWSS = new WebSocketServer({ server: leftHTTP })
    const rightWSS = new WebSocketServer({ server: rightHTTP })
    leftHTTP.listen(0, '127.0.0.1')
    rightHTTP.listen(0, '127.0.0.1')
    await Promise.all([waitListening(leftHTTP), waitListening(rightHTTP)])
    const leftAddress = leftHTTP.address()
    const rightAddress = rightHTTP.address()
    if (
      leftAddress === null ||
      rightAddress === null ||
      typeof leftAddress === 'string' ||
      typeof rightAddress === 'string'
    ) {
      throw new Error('missing address')
    }
    const acceptedLeft = waitConnection(leftWSS)
    const acceptedRight = waitConnection(rightWSS)
    const leftClient = new WebSocket(`ws://127.0.0.1:${leftAddress.port}`)
    const rightClient = new WebSocket(`ws://127.0.0.1:${rightAddress.port}`)
    const leftOpened = waitOpen(leftClient)
    const rightOpened = waitOpen(rightClient)
    const leftServer = await acceptedLeft
    const rightServer = await acceptedRight
    await Promise.all([leftOpened, rightOpened])
    const reply = waitMessage(leftClient)
    const pump = new BoundedMessagePump(rightClient, leftServer, {
      maxMessageBytes: 32,
      maxQueuedBytes: 64,
    })
    rightClient.on('message', (data, binary) => pump.enqueue(messageBufferForTest(data), binary))
    rightServer.send('hello')
    const { data } = await reply
    expect(data.toString()).toBe('hello')
    leftClient.terminate()
    rightClient.terminate()
    leftServer.terminate()
    rightServer.terminate()
    await Promise.all([
      new Promise<void>((resolve) => leftWSS.close(() => resolve())),
      new Promise<void>((resolve) => rightWSS.close(() => resolve())),
    ])
    await Promise.all([
      new Promise<void>((resolve) => leftHTTP.close(() => resolve())),
      new Promise<void>((resolve) => rightHTTP.close(() => resolve())),
    ])
  })

  it('delivers through an asynchronously upgraded noServer socket', async () => {
    const http = createServer()
    const wss = new WebSocketServer({ noServer: true })
    let serverSocket: WebSocket | undefined
    http.on('upgrade', (request, socket, head) => {
      setImmediate(() => {
        wss.handleUpgrade(request, socket, head, (accepted) => {
          serverSocket = accepted
          wss.emit('connection', accepted, request)
        })
      })
    })
    http.listen(0, '127.0.0.1')
    await waitListening(http)
    const address = http.address()
    if (address === null || typeof address === 'string') throw new Error('missing address')
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
    await waitOpen(client)
    if (serverSocket === undefined) throw new Error('missing server socket')
    const message = waitMessage(client)
    const pump = new BoundedMessagePump(serverSocket, serverSocket, {
      maxMessageBytes: 32,
      maxQueuedBytes: 64,
    })
    pump.enqueue(Buffer.from('hello'), false)
    const { data } = await message
    expect(data.toString()).toBe('hello')
    client.terminate()
    serverSocket.terminate()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    wss.close()
  })
})

function messageBufferForTest(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  throw new Error('unsupported')
}

function captureLimit(operation: () => void): RelayStreamLimitError {
  try {
    operation()
  } catch (error: unknown) {
    if (error instanceof RelayStreamLimitError) return error
    throw error
  }
  throw new Error('Expected the relay limit to reject the operation.')
}

function waitListening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
}

function waitConnection(server: WebSocketServer): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    server.once('connection', resolve)
    server.once('error', reject)
  })
}

function waitOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function waitMessage(socket: WebSocket): Promise<Readonly<{ data: Buffer; binary: boolean }>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data, binary) => resolve({ data: messageBufferForTest(data), binary }))
    socket.once('error', reject)
  })
}
