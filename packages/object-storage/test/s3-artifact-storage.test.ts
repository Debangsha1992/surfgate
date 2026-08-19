import { describe, expect, it, vi } from 'vitest'

import { createS3ArtifactStorage } from '../src/index.js'

const SIGNAL = new AbortController().signal
const VALID_KEY =
  'v1/ten_01ARZ3NDEKTSV4RRFFQ69G5FAV/tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV/art_01ARZ3NDEKTSV4RRFFQ69G5FAV/a1-0123456789abcdef'

describe('S3 artifact storage', () => {
  it('exposes a normalized bounded readiness probe', async () => {
    const ready = createS3ArtifactStorage(
      { region: 'auto', bucket: 'private-bucket', endpoint: undefined, credentials: undefined },
      { send: () => Promise.resolve({}) },
    )
    const unavailable = createS3ArtifactStorage(
      { region: 'auto', bucket: 'private-bucket', endpoint: undefined, credentials: undefined },
      { send: () => Promise.reject(new Error('Bearer storage-secret')) },
    )

    if (ready.health === undefined || unavailable.health === undefined) {
      throw new Error('Artifact storage readiness probe is required')
    }
    await expect(ready.health()).resolves.toBe('ready')
    await expect(unavailable.health()).resolves.toBe('unavailable')
  })

  it('uses an R2-compatible private object request without unsupported ACL or SSE headers', async () => {
    const commands: unknown[] = []
    const storage = createS3ArtifactStorage(
      { region: 'auto', bucket: 'private-bucket', endpoint: undefined, credentials: undefined },
      {
        send(command: unknown) {
          commands.push(command)
          return Promise.resolve({})
        },
      },
    )
    await storage.put(
      {
        key: VALID_KEY,
        mediaType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
        sha256: 'a'.repeat(64),
      },
      SIGNAL,
    )

    expect(commands).toHaveLength(1)
    expect(JSON.stringify(commands[0])).not.toContain('credential')
    expect((commands[0] as { input: object }).input).not.toHaveProperty('ACL')
    expect((commands[0] as { input: object }).input).not.toHaveProperty('ServerSideEncryption')
  })

  it('rejects path traversal storage keys before transport', async () => {
    const storage = createS3ArtifactStorage(
      { region: 'auto', bucket: 'private-bucket', endpoint: undefined, credentials: undefined },
      {
        send() {
          return Promise.reject(new Error('transport must not be called'))
        },
      },
    )
    await expect(storage.get('../secret', 100, SIGNAL)).rejects.toThrow(
      'Invalid artifact storage key',
    )
  })

  it('normalizes missing objects without exposing transport details', async () => {
    const storage = createS3ArtifactStorage(
      { region: 'auto', bucket: 'private-bucket', endpoint: undefined, credentials: undefined },
      {
        send() {
          return Promise.reject(
            Object.assign(new Error('secret upstream details'), { name: 'NoSuchKey' }),
          )
        },
      },
    )
    await expect(storage.get(VALID_KEY, 100, SIGNAL)).resolves.toBeNull()
  })

  it('streams artifact reads and stops at the configured byte limit', async () => {
    const sender = {
      send() {
        const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])]
        return Promise.resolve({
          ContentType: 'image/png',
          Body: {
            [Symbol.asyncIterator]() {
              let index = 0
              return {
                next() {
                  const value = chunks[index]
                  index += 1
                  return Promise.resolve(
                    value === undefined ? { done: true as const } : { done: false as const, value },
                  )
                },
              }
            },
          },
        })
      },
    }
    const storage = createS3ArtifactStorage(
      { region: 'auto', bucket: 'private-bucket', endpoint: undefined, credentials: undefined },
      sender,
    )

    await expect(storage.get(VALID_KEY, 3, SIGNAL)).resolves.toMatchObject({
      mediaType: 'image/png',
    })
    await expect(storage.get(VALID_KEY, 2, SIGNAL)).rejects.toThrow('exceeds the permitted size')
  })

  it('fails before transport when storage work is already cancelled', async () => {
    const send = vi.fn().mockResolvedValue({})
    const storage = createS3ArtifactStorage(
      { region: 'auto', bucket: 'private-bucket', endpoint: undefined, credentials: undefined },
      { send },
    )
    const controller = new AbortController()
    controller.abort()

    await expect(storage.get(VALID_KEY, 100, controller.signal)).rejects.toThrow('cancelled')
    expect(send).not.toHaveBeenCalled()
  })
})
