import { chromium } from 'playwright-core'
import { RelayTokenResponseSchema } from '@surfgate/contracts'

import { request } from '../request.mjs'

const apiURL = process.env.SURFGATE_API_URL ?? 'http://127.0.0.1:8080'
const apiKey = process.env.SURFGATE_API_KEY
const sessionId = process.env.SURFGATE_SESSION_ID
const targetURL = process.env.SURFGATE_EXAMPLE_URL ?? 'https://example.com/'
if (!apiKey || !sessionId) {
  throw new Error('Set SURFGATE_API_KEY and SURFGATE_SESSION_ID before running this example.')
}

const response = await request(
  'Relay-token request',
  `${apiURL}/v1/sessions/${encodeURIComponent(sessionId)}/relay-token`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
  },
)
if (!response.ok) throw new Error(`Relay-token request failed with HTTP ${response.status}.`)
const relay = RelayTokenResponseSchema.parse(await response.json())

const browser = await chromium.connectOverCDP(relay.webSocketUrl, {
  headers: { Authorization: `Bearer ${relay.token}` },
})
try {
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto(targetURL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  console.log(`Navigation completed with HTTP(S) origin ${new URL(page.url()).origin}.`)
} finally {
  await browser.close()
}
