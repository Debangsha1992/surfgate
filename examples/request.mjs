const REQUEST_TIMEOUT_MS = 30_000

export async function request(operation, input, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal =
    init.signal === undefined || init.signal === null
      ? timeoutSignal
      : AbortSignal.any([init.signal, timeoutSignal])
  try {
    return await fetch(input, {
      ...init,
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error(`${operation} timed out after ${timeoutMs} ms.`, { cause: error })
    }
    throw error
  }
}
