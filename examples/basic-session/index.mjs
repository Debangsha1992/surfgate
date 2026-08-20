import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'

import { SessionCreateResponseSchema, SessionTerminationResponseSchema } from '@surfgate/contracts'

import { request } from '../request.mjs'

const apiURL = process.env.SURFGATE_API_URL ?? 'http://127.0.0.1:8080'
const apiKey = process.env.SURFGATE_API_KEY
if (!apiKey) throw new Error('Set SURFGATE_API_KEY before running this example.')

const headers = {
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
}
const response = await request('Session creation', `${apiURL}/v1/sessions`, {
  method: 'POST',
  headers: { ...headers, 'Idempotency-Key': `example-${randomUUID()}` },
  body: JSON.stringify({
    capabilities: { javascript: 'required', dom: 'required' },
    runtime: { preference: 'auto', allowFallback: true, allowExperimental: false },
    maxDurationSeconds: 600,
    metadata: { application: 'basic-session' },
  }),
})
if (!response.ok) throw new Error(`Session creation failed with HTTP ${response.status}.`)

const created = SessionCreateResponseSchema.parse(await response.json())
console.log(JSON.stringify(created, null, 2))

const sessionId = created.session.id
const terminal = createInterface({ input: process.stdin, output: process.stdout })
await terminal.question('Press Enter to terminate the session. ')
terminal.close()

const terminated = await request(
  'Session termination',
  `${apiURL}/v1/sessions/${encodeURIComponent(sessionId)}`,
  {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey}` },
  },
)
if (!terminated.ok) throw new Error(`Session termination failed with HTTP ${terminated.status}.`)
console.log(
  JSON.stringify(SessionTerminationResponseSchema.parse(await terminated.json()), null, 2),
)
