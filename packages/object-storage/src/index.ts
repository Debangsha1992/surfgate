import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { ObjectStorageConfig } from '@surfgate/config'
import type { ArtifactStorage } from '@surfgate/task-core'

const STORAGE_KEY_PATTERN =
  /^v1\/ten_[0-7][0-9A-HJKMNP-TV-Z]{25}\/tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}\/art_[0-7][0-9A-HJKMNP-TV-Z]{25}\/a[1-9][0-9]?-[0-9a-f]{16}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

type S3Command = PutObjectCommand | GetObjectCommand | DeleteObjectCommand | HeadBucketCommand
export interface S3CommandSender {
  send(command: S3Command, options?: Readonly<{ abortSignal: AbortSignal }>): Promise<unknown>
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Artifact storage operation was cancelled.')
}

function validatedKey(key: string): string {
  if (!STORAGE_KEY_PATTERN.test(key)) throw new Error('Invalid artifact storage key.')
  return key
}

function defaultSender(config: ObjectStorageConfig): S3CommandSender {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint.href }),
    ...(config.credentials === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: config.credentials.accessKeyID,
            secretAccessKey: config.credentials.secretAccessKey,
          },
        }),
  })
  return Object.freeze({
    send(command: S3Command, options?: Readonly<{ abortSignal: AbortSignal }>): Promise<unknown> {
      if (command instanceof PutObjectCommand) return client.send(command, options)
      if (command instanceof GetObjectCommand) return client.send(command, options)
      if (command instanceof HeadBucketCommand) return client.send(command, options)
      return client.send(command, options)
    },
  })
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

async function readBoundedBody(
  body: unknown,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  if (body === null || typeof body !== 'object') return null
  const iterable = body as AsyncIterable<unknown>
  if (typeof iterable[Symbol.asyncIterator] !== 'function') return null
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const rawChunk of iterable) {
    assertNotAborted(signal)
    const chunk =
      rawChunk instanceof Uint8Array
        ? rawChunk
        : rawChunk instanceof ArrayBuffer
          ? new Uint8Array(rawChunk)
          : null
    if (chunk === null) throw new Error('Artifact object body is invalid.')
    total += chunk.byteLength
    if (total > maxBytes) throw new Error('Artifact object exceeds the permitted size.')
    chunks.push(chunk)
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  )
}

export function createS3ArtifactStorage(
  config: ObjectStorageConfig,
  sender: S3CommandSender = defaultSender(config),
): ArtifactStorage {
  const storage: ArtifactStorage = {
    async health(): Promise<'ready' | 'unavailable'> {
      try {
        await sender.send(new HeadBucketCommand({ Bucket: config.bucket }), {
          abortSignal: AbortSignal.timeout(5_000),
        })
        return 'ready'
      } catch {
        return 'unavailable'
      }
    },
    async put(input, signal): Promise<void> {
      assertNotAborted(signal)
      const key = validatedKey(input.key)
      if (input.bytes.byteLength > 64 * 1_024 * 1_024 || !SHA256_PATTERN.test(input.sha256)) {
        throw new Error('Invalid artifact object.')
      }
      await sender.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: input.bytes,
          ContentLength: input.bytes.byteLength,
          ContentType: input.mediaType,
          ChecksumSHA256: Buffer.from(input.sha256, 'hex').toString('base64'),
        }),
        { abortSignal: signal },
      )
    },
    async get(key, maxBytes, signal) {
      assertNotAborted(signal)
      const validatedStorageKey = validatedKey(key)
      let rawResponse: unknown
      try {
        rawResponse = await sender.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: validatedStorageKey }),
          { abortSignal: signal },
        )
      } catch (error: unknown) {
        assertNotAborted(signal)
        const details = record(error)
        if (details?.name === 'NoSuchKey' || details?.Code === 'NoSuchKey') return null
        throw new Error('Artifact object could not be read.')
      }
      const response = record(rawResponse)
      if (response === null) return null
      const contentLength = response.ContentLength
      if (typeof contentLength === 'number' && contentLength > maxBytes) {
        throw new Error('Artifact object exceeds the permitted size.')
      }
      const bytes = await readBoundedBody(response.Body, maxBytes, signal)
      if (bytes === null) return null
      const mediaType = response.ContentType
      if (typeof mediaType !== 'string') throw new Error('Artifact object metadata is invalid.')
      return Object.freeze({ bytes, mediaType })
    },
    async delete(key, signal): Promise<void> {
      assertNotAborted(signal)
      await sender.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: validatedKey(key) }),
        { abortSignal: signal },
      )
    },
  }
  return Object.freeze(storage)
}
