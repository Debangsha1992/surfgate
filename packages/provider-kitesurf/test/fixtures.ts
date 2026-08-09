import type { CloudflareConfig } from '@surfgate/config'
import {
  ProviderAllocateRequestSchema,
  type ProviderAllocateRequest,
} from '@surfgate/provider-core'

export const TEST_ACCOUNT_ID = '0123456789abcdef0123456789abcdef'
export const TEST_API_TOKEN = 'test-token-never-log'
export const TEST_SESSION_ID = '1909cef7-23e8-4394-bc31-27404bf4348f'
export const TEST_NOW = new Date('2026-08-08T00:00:00.000Z')

export const CONFIGURED_CLOUDFLARE_CONFIG: CloudflareConfig = Object.freeze({
  apiBaseURL: new URL('https://api.cloudflare.com/client/v4'),
  credentials: Object.freeze({
    accountID: TEST_ACCOUNT_ID,
    browserRunAPIToken: TEST_API_TOKEN,
  }),
})

export const UNCONFIGURED_CLOUDFLARE_CONFIG: CloudflareConfig = Object.freeze({
  apiBaseURL: new URL('https://api.cloudflare.com/client/v4'),
  credentials: undefined,
})

export const VALID_CREATE_RESPONSE = Object.freeze({
  sessionId: TEST_SESSION_ID,
  webSocketDebuggerUrl:
    `wss://api.cloudflare.com/client/v4/accounts/${TEST_ACCOUNT_ID}` +
    `/browser-run/devtools/browser/${TEST_SESSION_ID}`,
})

export function createKitesurfAllocateRequest(
  overrides: Readonly<Record<string, unknown>> = {},
): ProviderAllocateRequest {
  return ProviderAllocateRequestSchema.parse({
    requestID: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runtimeClass: 'kitesurf',
    requirements: {
      javascript: 'required',
      screenshot: 'preferred',
    },
    allowExperimental: true,
    maxSessionDurationMs: 60_000,
    targetURL: 'https://example.com/',
    metadata: { operationName: 'provider.allocate' },
    ...overrides,
  })
}
