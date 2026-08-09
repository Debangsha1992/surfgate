import type { CloudflareConfig } from '@surfgate/config'
import { CapabilitySupportMapSchema } from '@surfgate/contracts'
import {
  CloudflareBrowserRunProvider,
  type CloudflareBrowserRunProfile,
  type CloudflareProviderOptions,
} from '@surfgate/provider-cloudflare'

const KITESURF_IMPLEMENTATION_VERSION = '2026-08-07'
const MAX_KITESURF_SESSION_DURATION_MS = 10 * 60 * 1_000

// Source: Cloudflare Kitesurf docs, last verified 2026-08-07. The beta docs
// explicitly covered the first six capabilities and excluded the next five.
// Downloads and uploads remain unknown rather than inferred.
export const KITESURF_CAPABILITIES = CapabilitySupportMapSchema.parse({
  javascript: 'experimental',
  dom: 'experimental',
  xhr: 'experimental',
  svg: 'experimental',
  screenshot: 'experimental',
  pdf: 'experimental',
  webgl: 'unsupported',
  video: 'unsupported',
  persistentAuth: 'unsupported',
  realBrowserTLS: 'unsupported',
  downloads: 'unknown',
  uploads: 'unknown',
  multiTab: 'unsupported',
  longSession: 'unsupported',
})

const KITESURF_PROFILE: CloudflareBrowserRunProfile = Object.freeze({
  apiNamespace: 'browser-run',
  acceptedConnectionNamespaces: Object.freeze(['browser-run', 'browser-rendering'] as const),
  browserSelector: 'kitesurf',
  runtimeClass: 'kitesurf',
  displayName: 'Cloudflare Browser Run — Kitesurf',
  capabilities: KITESURF_CAPABILITIES,
  implementationName: '@surfgate/provider-kitesurf',
  implementationVersion: KITESURF_IMPLEMENTATION_VERSION,
  configProfile: 'browser-run-kitesurf-beta',
  maximumKeepAliveMs: MAX_KITESURF_SESSION_DURATION_MS,
  maximumSessionDurationMs: MAX_KITESURF_SESSION_DURATION_MS,
})

export type KitesurfProviderOptions = CloudflareProviderOptions

export class KitesurfBrowserProvider extends CloudflareBrowserRunProvider {
  constructor(config: CloudflareConfig, options: KitesurfProviderOptions = {}) {
    super(config, KITESURF_PROFILE, options)
  }
}

export function createKitesurfBrowserProvider(
  config: CloudflareConfig,
  options: KitesurfProviderOptions = {},
): KitesurfBrowserProvider {
  return new KitesurfBrowserProvider(config, options)
}
