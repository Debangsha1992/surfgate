import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'

const apiURL = process.env.SURFGATE_API_URL ?? 'http://127.0.0.1:8080'
const apiKey = process.env.SURFGATE_API_KEY
if (!apiKey) throw new Error('Set SURFGATE_API_KEY before running this example.')

const headers = {
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
}
const response = await fetch(`${apiURL}/v1/sessions`, {
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

const created = await response.json()
console.log(JSON.stringify(created, null, 2))

const sessionId = created?.session?.id
if (typeof sessionId !== 'string') throw new Error('Response did not contain a session ID.')
const terminal = createInterface({ input: process.stdin, output: process.stdout })
await terminal.question('Press Enter to terminate the session. ')
terminal.close()

const terminated = await fetch(`${apiURL}/v1/sessions/${encodeURIComponent(sessionId)}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${apiKey}` },
})
if (!terminated.ok) throw new Error(`Session termination failed with HTTP ${terminated.status}.`)
console.log(JSON.stringify(await terminated.json(), null, 2))
