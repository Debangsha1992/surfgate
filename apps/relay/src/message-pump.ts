import type { RelayFailureCode } from './relay-types.js'

export interface PumpSocket {
  readonly bufferedAmount: number
  send(
    data: Buffer,
    options: Readonly<{ binary: boolean }>,
    callback: (error?: Error) => void,
  ): void
  pause(): void
  resume(): void
}

export class RelayStreamLimitError extends Error {
  readonly code: 'MESSAGE_TOO_LARGE' | 'BACKPRESSURE_LIMIT'

  constructor(code: 'MESSAGE_TOO_LARGE' | 'BACKPRESSURE_LIMIT') {
    super('The relay stream exceeded a configured safety limit.')
    this.name = 'RelayStreamLimitError'
    this.code = code
  }
}

type QueuedMessage = Readonly<{ data: Buffer; binary: boolean; bytes: number }>

export class BoundedMessagePump {
  readonly #source: PumpSocket
  readonly #target: PumpSocket
  readonly #limits: Readonly<{ maxMessageBytes: number; maxQueuedBytes: number }>
  readonly #onFailure: (code: RelayFailureCode) => void
  readonly #onDelivered: (bytes: number) => void
  readonly #queue: QueuedMessage[] = []
  #queuedBytes = 0
  #sending = false
  #closed = false
  #paused = false

  constructor(
    source: PumpSocket,
    target: PumpSocket,
    limits: Readonly<{ maxMessageBytes: number; maxQueuedBytes: number }>,
    onFailure: (code: RelayFailureCode) => void = () => undefined,
    onDelivered: (bytes: number) => void = () => undefined,
  ) {
    this.#source = source
    this.#target = target
    this.#limits = limits
    this.#onFailure = onFailure
    this.#onDelivered = onDelivered
  }

  enqueue(data: Buffer, binary: boolean): void {
    if (this.#closed) return
    if (data.byteLength > this.#limits.maxMessageBytes) {
      this.#onFailure('MESSAGE_TOO_LARGE')
      throw new RelayStreamLimitError('MESSAGE_TOO_LARGE')
    }
    if (
      this.#queuedBytes + data.byteLength > this.#limits.maxQueuedBytes ||
      this.#target.bufferedAmount + data.byteLength > this.#limits.maxQueuedBytes
    ) {
      this.#onFailure('BACKPRESSURE_LIMIT')
      throw new RelayStreamLimitError('BACKPRESSURE_LIMIT')
    }
    const ownedData = Buffer.from(data)
    this.#queue.push({ data: ownedData, binary, bytes: ownedData.byteLength })
    this.#queuedBytes += data.byteLength
    if ((this.#sending || this.#queue.length > 1) && !this.#paused) {
      this.#source.pause()
      this.#paused = true
    }
    this.#drain()
  }

  close(): void {
    this.#closed = true
    this.#queue.length = 0
    this.#queuedBytes = 0
    if (this.#paused) {
      this.#source.resume()
      this.#paused = false
    }
  }

  #drain(): void {
    if (this.#closed || this.#sending) return
    const message = this.#queue.shift()
    if (message === undefined) {
      if (this.#paused) {
        this.#source.resume()
        this.#paused = false
      }
      return
    }
    this.#sending = true
    this.#target.send(message.data, { binary: message.binary }, (error?: Error) => {
      this.#sending = false
      if (!this.#closed) this.#queuedBytes -= message.bytes
      if (error !== undefined && error !== null) {
        this.close()
        this.#onFailure('UPSTREAM_CLOSED')
        return
      }
      this.#onDelivered(message.bytes)
      this.#drain()
    })
  }
}
