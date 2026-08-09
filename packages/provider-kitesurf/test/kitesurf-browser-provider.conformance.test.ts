import { runProviderConformanceSuite, type ProviderConformanceScenario } from '@surfgate/testing'

import { createKitesurfBrowserProvider } from '../src/index.js'
import {
  CONFIGURED_CLOUDFLARE_CONFIG,
  TEST_API_TOKEN,
  TEST_NOW,
  TEST_SESSION_ID,
  UNCONFIGURED_CLOUDFLARE_CONFIG,
  VALID_CREATE_RESPONSE,
  createKitesurfAllocateRequest,
} from './fixtures.js'

function jsonResponse(body: unknown, status = 200, headers?: Readonly<Record<string, string>>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function pendingResponse(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const rejectAborted = (): void => {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    if (signal?.aborted === true) {
      rejectAborted()
      return
    }
    signal?.addEventListener('abort', rejectAborted, { once: true })
  })
}

function healthResponse(
  scenario: ProviderConformanceScenario,
  signal: AbortSignal | null | undefined,
): Response | Promise<Response> {
  switch (scenario) {
    case 'degraded':
      return jsonResponse({ errors: [] }, 429, { 'retry-after': '1' })
    case 'unavailable':
      return jsonResponse({ errors: [] }, 503)
    case 'health_delayed':
    case 'health_timeout':
      return pendingResponse(signal)
    case 'health_unknown_error':
      throw new Error('raw health failure')
    case 'health_secret_error':
      throw new Error('Bearer provider-secret from upstream.internal.local Authorization')
    default:
      return jsonResponse([])
  }
}

function allocationResponse(
  scenario: ProviderConformanceScenario,
  signal: AbortSignal | null | undefined,
): Response | Promise<Response> {
  switch (scenario) {
    case 'allocation_delayed':
    case 'allocation_timeout':
      return pendingResponse(signal)
    case 'allocation_authorization_error':
      return jsonResponse({ errors: [] }, 403)
    case 'allocation_rate_limited':
      return jsonResponse({ errors: [] }, 429, { 'retry-after': '1' })
    case 'allocation_transient_error':
      return jsonResponse({ errors: [] }, 503)
    case 'allocation_unsupported':
      return jsonResponse({ errors: [] }, 422)
    case 'allocation_connection_error':
      throw new TypeError('connection refused')
    case 'allocation_unknown_error':
      throw new Error('unclassified upstream failure')
    case 'allocation_secret_error':
      throw new Error('Bearer provider-secret from upstream.internal.local Authorization')
    default:
      return jsonResponse(VALID_CREATE_RESPONSE)
  }
}

function terminationResponse(
  scenario: ProviderConformanceScenario,
  sessionID: string,
  signal: AbortSignal | null | undefined,
): Response | Promise<Response> {
  if (sessionID.includes('nonexistent')) {
    return jsonResponse({ errors: [] }, 404)
  }
  switch (scenario) {
    case 'termination_delayed':
    case 'termination_timeout':
      return pendingResponse(signal)
    case 'termination_error':
      return jsonResponse({ errors: [] }, 409)
    case 'termination_unknown_error':
      throw new Error('unclassified upstream failure')
    case 'termination_secret_error':
      throw new Error('Bearer provider-secret from upstream.internal.local Authorization')
    default:
      return jsonResponse({ status: 'closing' })
  }
}

function createScenarioFetch(scenario: ProviderConformanceScenario): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    if (headers.get('authorization') !== `Bearer ${TEST_API_TOKEN}`) {
      return jsonResponse({ errors: [] }, 403)
    }

    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.pathname.endsWith('/devtools/session')) {
      return healthResponse(scenario, init?.signal)
    }
    if (method === 'POST' && url.pathname.endsWith('/devtools/browser')) {
      return allocationResponse(scenario, init?.signal)
    }
    if (method === 'DELETE') {
      return terminationResponse(
        scenario,
        url.pathname.split('/').at(-1) ?? TEST_SESSION_ID,
        init?.signal,
      )
    }
    throw new Error('Unexpected conformance request')
  }
}

function createConformanceProvider(scenario: ProviderConformanceScenario) {
  const config =
    scenario === 'unconfigured' || scenario === 'allocation_configuration_error'
      ? UNCONFIGURED_CLOUDFLARE_CONFIG
      : CONFIGURED_CLOUDFLARE_CONFIG

  return createKitesurfBrowserProvider(config, {
    fetch: createScenarioFetch(scenario),
    now: () => TEST_NOW,
    monotonicNow: () => 10,
  })
}

runProviderConformanceSuite({
  name: 'KitesurfBrowserProvider',
  createProvider: createConformanceProvider,
  allocateRequest: createKitesurfAllocateRequest,
})
