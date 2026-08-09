import type { CloudflareConfig, CloudflareCredentials } from '@surfgate/config'
import {
  ProviderError,
  ProviderOperationOptionsSchema,
  normalizeProviderError,
  throwIfProviderOperationAborted,
  type ProviderErrorCode,
  type ProviderOperation,
  type ProviderOperationOptions,
} from '@surfgate/provider-core'

const CLOUDFLARE_API_HOSTNAME = 'api.cloudflare.com'
const MAX_RETRY_AFTER_MS = 10 * 60 * 1_000
const MAX_ERROR_RESPONSE_BYTES = 8 * 1_024
const DAILY_BROWSER_QUOTA_MESSAGE = 'Browser time limit exceeded for today'

export type CloudflareAPINamespace = 'browser-run' | 'browser-rendering'

export type CloudflareTransportOptions = Readonly<{
  apiNamespace: CloudflareAPINamespace
  fetch: typeof fetch
  nowEpochMs: () => number
}>

export type CloudflareRequest = Readonly<{
  operation: ProviderOperation
  method: 'GET' | 'POST' | 'DELETE'
  path: readonly string[]
  query?: Readonly<Record<string, string>>
}>

function validateBaseURL(apiBaseURL: URL): URL {
  const validated = new URL(apiBaseURL.href)
  if (
    validated.protocol !== 'https:' ||
    validated.hostname !== CLOUDFLARE_API_HOSTNAME ||
    validated.port.length > 0 ||
    validated.username.length > 0 ||
    validated.password.length > 0 ||
    validated.pathname.replace(/\/+$/u, '') !== '/client/v4' ||
    validated.search.length > 0 ||
    validated.hash.length > 0
  ) {
    throw new ProviderError({
      code: 'PROVIDER_CONFIGURATION_ERROR',
      operation: 'descriptor',
      diagnosticCode: 'CLOUDFLARE_API_BASE_URL_INVALID',
    })
  }
  return validated
}

function validateCredentials(credentials: CloudflareCredentials | undefined): void {
  if (credentials === undefined) {
    return
  }
  if (
    !/^[0-9a-f]{32}$/u.test(credentials.accountID) ||
    credentials.browserRunAPIToken.trim().length === 0
  ) {
    throw new ProviderError({
      code: 'PROVIDER_CONFIGURATION_ERROR',
      operation: 'descriptor',
      diagnosticCode: 'CLOUDFLARE_CREDENTIALS_INVALID',
    })
  }
}

function mapFetchFailure(
  error: unknown,
  operation: ProviderOperation,
  callerAborted: boolean,
  timedOut: boolean,
): ProviderError {
  if (callerAborted) {
    return new ProviderError({ code: 'PROVIDER_OPERATION_ABORTED', operation })
  }
  if (timedOut) {
    return new ProviderError({ code: 'PROVIDER_OPERATION_TIMEOUT', operation })
  }
  if (error instanceof TypeError) {
    return new ProviderError({ code: 'PROVIDER_CONNECTION_FAILED', operation })
  }
  return normalizeProviderError(error, operation)
}

async function parseBoundedErrorJSON(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) {
    return undefined
  }
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const result = (await reader.read()) as Readonly<{ done: boolean; value?: unknown }>
      if (result.done) {
        break
      }
      const chunk = result.value
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError('Cloudflare error response returned a non-byte chunk')
      }
      totalBytes += chunk.byteLength
      if (totalBytes > MAX_ERROR_RESPONSE_BYTES) {
        throw new RangeError('Cloudflare error response exceeded the configured limit')
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
    if (totalBytes > MAX_ERROR_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined)
    }
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function isDocumentedCapacityError(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('errors' in value)) {
    return false
  }
  const errors: unknown = value.errors
  if (!Array.isArray(errors)) {
    return false
  }
  return errors.some((error: unknown) => {
    if (typeof error !== 'object' || error === null || !('message' in error)) {
      return false
    }
    const message: unknown = error.message
    return message === DAILY_BROWSER_QUOTA_MESSAGE
  })
}

export class CloudflareBrowserRunTransport {
  readonly #apiBaseURL: URL
  readonly #apiNamespace: CloudflareAPINamespace
  readonly #credentials: CloudflareCredentials | undefined
  readonly #fetch: typeof fetch
  readonly #nowEpochMs: () => number

  constructor(config: CloudflareConfig, options: CloudflareTransportOptions) {
    this.#apiBaseURL = validateBaseURL(config.apiBaseURL)
    validateCredentials(config.credentials)
    this.#apiNamespace = options.apiNamespace
    this.#credentials = config.credentials
    this.#fetch = options.fetch
    this.#nowEpochMs = options.nowEpochMs
  }

  get configured(): boolean {
    return this.#credentials !== undefined
  }

  async request<Result>(
    request: CloudflareRequest,
    options: ProviderOperationOptions,
    consume: (response: Response) => Promise<Result>,
  ): Promise<Result> {
    const validatedOptions = ProviderOperationOptionsSchema.parse(options)
    throwIfProviderOperationAborted(validatedOptions.signal, request.operation)
    const credentials = this.#credentials
    if (credentials === undefined) {
      throw new ProviderError({
        code: 'PROVIDER_CONFIGURATION_ERROR',
        operation: request.operation,
        diagnosticCode: 'CLOUDFLARE_NOT_CONFIGURED',
      })
    }

    const controller = new AbortController()
    let timedOut = false
    const onCallerAbort = (): void => {
      controller.abort()
    }
    validatedOptions.signal?.addEventListener('abort', onCallerAbort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, validatedOptions.timeoutMs)

    try {
      const response = await this.#fetch(this.#buildURL(credentials.accountID, request), {
        method: request.method,
        headers: { Authorization: `Bearer ${credentials.browserRunAPIToken}` },
        redirect: 'error',
        signal: controller.signal,
      })
      return await consume(response)
    } catch (error: unknown) {
      throw mapFetchFailure(
        error,
        request.operation,
        validatedOptions.signal?.aborted === true,
        timedOut,
      )
    } finally {
      clearTimeout(timeout)
      validatedOptions.signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  retryAfterMs(response: Response): number | undefined {
    const rawValue = response.headers.get('retry-after')?.trim()
    if (rawValue === undefined || rawValue.length === 0) {
      return undefined
    }
    if (/^\d+$/u.test(rawValue)) {
      return Math.min(Number(rawValue) * 1_000, MAX_RETRY_AFTER_MS)
    }
    const retryAt = Date.parse(rawValue)
    if (Number.isNaN(retryAt)) {
      return undefined
    }
    return Math.min(Math.max(0, retryAt - this.#nowEpochMs()), MAX_RETRY_AFTER_MS)
  }

  async errorForResponse(response: Response, operation: ProviderOperation): Promise<ProviderError> {
    const retryAfterMs = this.retryAfterMs(response)
    let capacityExhausted = false
    if (response.status === 429) {
      try {
        capacityExhausted = isDocumentedCapacityError(await parseBoundedErrorJSON(response))
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error
        }
        await response.body?.cancel().catch(() => undefined)
      }
    } else {
      await response.body?.cancel().catch(() => undefined)
    }

    let code: ProviderErrorCode
    if (response.status === 401 || response.status === 403) {
      code = 'PROVIDER_AUTHORIZATION_ERROR'
    } else if (response.status === 429) {
      code = capacityExhausted ? 'PROVIDER_CAPACITY_EXHAUSTED' : 'PROVIDER_RATE_LIMITED'
    } else if (response.status >= 500) {
      code = 'PROVIDER_TRANSIENT_UPSTREAM_FAILURE'
    } else if (operation === 'terminate') {
      code = 'PROVIDER_TERMINATION_FAILED'
    } else if (response.status === 400 || response.status === 404 || response.status === 422) {
      code = 'PROVIDER_UNSUPPORTED'
    } else {
      code = 'PROVIDER_UNKNOWN_ERROR'
    }

    return new ProviderError({
      code,
      operation,
      diagnosticCode: `CLOUDFLARE_HTTP_${response.status}`,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    })
  }

  #buildURL(accountID: string, request: CloudflareRequest): URL {
    const url = new URL(this.#apiBaseURL.href)
    const basePath = url.pathname.replace(/\/+$/u, '')
    const path = ['accounts', accountID, this.#apiNamespace, 'devtools', ...request.path]
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    url.pathname = `${basePath}/${path}`
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value)
    }
    return url
  }
}
