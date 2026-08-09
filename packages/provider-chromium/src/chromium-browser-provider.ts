import type { CloudflareConfig } from '@surfgate/config'
import { CapabilitySupportMapSchema } from '@surfgate/contracts'
import {
  CloudflareBrowserRunProvider,
  type CloudflareBrowserRunProfile,
  type CloudflareProviderOptions,
} from '@surfgate/provider-cloudflare'

const CHROMIUM_IMPLEMENTATION_VERSION = '2026-08-08'
const MAX_CLOUDFLARE_KEEP_ALIVE_MS = 10 * 60 * 1_000

// Current Cloudflare Browser Run docs describe a stable headless Chrome/CDP
// runtime with multi-tab, session reuse, storage state, screenshots, PDFs, and
// active sessions without a fixed maximum lifetime. The prior Kitesurf
// compatibility guidance explicitly directs WebGL, real-browser TLS, and video
// workloads to Chromium; current Playwright documentation still says video is
// not fully supported, so video remains experimental. Product behavior not
// documented by Cloudflare stays unknown even when upstream Chromium commonly
// implements it.
export const CHROMIUM_CAPABILITIES = CapabilitySupportMapSchema.parse({
  javascript: 'supported',
  dom: 'supported',
  xhr: 'supported',
  svg: 'supported',
  screenshot: 'supported',
  pdf: 'supported',
  webgl: 'supported',
  video: 'experimental',
  persistentAuth: 'supported',
  realBrowserTLS: 'supported',
  downloads: 'unknown',
  uploads: 'unknown',
  multiTab: 'supported',
  longSession: 'supported',
})

const CHROMIUM_PROFILE: CloudflareBrowserRunProfile = Object.freeze({
  apiNamespace: 'browser-rendering',
  acceptedConnectionNamespaces: Object.freeze(['browser-rendering'] as const),
  runtimeClass: 'chromium',
  displayName: 'Cloudflare Browser Run — Chromium',
  capabilities: CHROMIUM_CAPABILITIES,
  implementationName: '@surfgate/provider-chromium',
  implementationVersion: CHROMIUM_IMPLEMENTATION_VERSION,
  configProfile: 'browser-run-chromium',
  maximumKeepAliveMs: MAX_CLOUDFLARE_KEEP_ALIVE_MS,
})

export type ChromiumProviderOptions = CloudflareProviderOptions

export class ChromiumBrowserProvider extends CloudflareBrowserRunProvider {
  constructor(config: CloudflareConfig, options: ChromiumProviderOptions = {}) {
    super(config, CHROMIUM_PROFILE, options)
  }
}

export function createChromiumBrowserProvider(
  config: CloudflareConfig,
  options: ChromiumProviderOptions = {},
): ChromiumBrowserProvider {
  return new ChromiumBrowserProvider(config, options)
}
