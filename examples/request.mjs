const REQUEST_TIMEOUT_MS = 30_000

export async function request(operation, input, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    return await fetch(input, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error(`${operation} timed out after ${timeoutMs} ms.`, { cause: error })
    }
    throw error
  }
}
