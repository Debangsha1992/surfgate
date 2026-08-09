import type { CloudflareConfig } from '@surfgate/config'
import {
  ProviderSessionSchema,
  ResolvedProviderConnectionSchema,
  type ProviderSession,
  type ResolvedProviderConnection,
} from '@surfgate/provider-core'

const NAMESPACES = {
  kitesurf: ['browser-run', 'browser-rendering'],
  chromium: ['browser-rendering'],
} as const

export function resolveCloudflareBrowserRunConnection(
  config: CloudflareConfig,
  rawSession: ProviderSession,
): ResolvedProviderConnection {
  const session = ProviderSessionSchema.parse(rawSession)
  const credentials = config.credentials
  if (
    credentials === undefined ||
    session.reference.providerID !== 'cloudflare-browser-run' ||
    session.connection.credentialReference !==
      `cloudflare-browser-run:${session.reference.providerSessionID}`
  ) {
    throw new Error('Provider relay connection could not be resolved.')
  }
  const endpoint = new URL(session.connection.endpoint)
  const basePath = config.apiBaseURL.pathname.replace(/\/+$/u, '')
  const runtimeClass = session.reference.runtimeClass
  const namespaces =
    runtimeClass === 'kitesurf'
      ? NAMESPACES.kitesurf
      : runtimeClass === 'chromium'
        ? NAMESPACES.chromium
        : undefined
  const validPaths = namespaces?.map(
    (namespace) =>
      `${basePath}/accounts/${credentials.accountID}/${namespace}/devtools/browser/${session.reference.providerSessionID}`,
  )
  if (
    endpoint.protocol !== 'wss:' ||
    endpoint.hostname !== 'api.cloudflare.com' ||
    endpoint.port.length > 0 ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0 ||
    validPaths === undefined ||
    !validPaths.includes(endpoint.pathname)
  ) {
    throw new Error('Provider relay connection could not be resolved.')
  }
  return ResolvedProviderConnectionSchema.parse({
    endpoint: endpoint.href,
    headers: { Authorization: `Bearer ${credentials.browserRunAPIToken}` },
  })
}
