export type FetchStep =
  | Readonly<{
      kind: 'response'
      status?: number
      body: unknown
      headers?: Readonly<Record<string, string>>
    }>
  | Readonly<{ kind: 'throw'; value: unknown }>
  | Readonly<{ kind: 'pending'; onRequest?: () => void; onAbort?: () => void }>
  | Readonly<{ kind: 'delayed_body'; body: unknown; delayMs: number }>

export type SafeFetchCall = Readonly<{
  method: string
  url: string
  headerNames: readonly string[]
  authorizationIsExpected: boolean
  redirectPolicy: RequestInit['redirect']
}>

export function createScriptedFetch(
  steps: readonly FetchStep[],
  expectedToken: string,
): Readonly<{ fetch: typeof fetch; calls: SafeFetchCall[] }> {
  const remaining = [...steps]
  const calls: SafeFetchCall[] = []

  const scriptedFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const step = remaining.shift()
    if (step === undefined) {
      throw new Error('Scripted fetch received an unexpected request')
    }

    const headers = new Headers(init?.headers)
    calls.push(
      Object.freeze({
        method: init?.method ?? 'GET',
        url: input instanceof Request ? input.url : String(input),
        headerNames: Object.freeze([...headers.keys()].sort()),
        authorizationIsExpected: headers.get('authorization') === `Bearer ${expectedToken}`,
        redirectPolicy: init?.redirect,
      }),
    )

    if (step.kind === 'throw') {
      throw step.value
    }
    if (step.kind === 'pending') {
      step.onRequest?.()
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const rejectAborted = (): void => {
          step.onAbort?.()
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        }
        if (signal?.aborted === true) {
          rejectAborted()
          return
        }
        signal?.addEventListener('abort', rejectAborted, { once: true })
      })
    }
    if (step.kind === 'delayed_body') {
      const encodedBody = new TextEncoder().encode(JSON.stringify(step.body))
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const timer = setTimeout(() => {
            controller.enqueue(encodedBody)
            controller.close()
          }, step.delayMs)
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              controller.error(new DOMException('The operation was aborted.', 'AbortError'))
            },
            { once: true },
          )
        },
      })
      return new Response(body, { headers: { 'content-type': 'application/json' } })
    }

    return new Response(JSON.stringify(step.body), {
      status: step.status ?? 200,
      headers: { 'content-type': 'application/json', ...step.headers },
    })
  }

  return { fetch: scriptedFetch, calls }
}
