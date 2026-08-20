import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

const apiURL = process.env.SURFGATE_API_URL ?? 'http://127.0.0.1:8080'
const apiKey = process.env.SURFGATE_API_KEY
const sessionId = process.env.SURFGATE_SESSION_ID
const taskType = process.env.SURFGATE_TASK_TYPE ?? 'extract'
if (!apiKey || !sessionId) {
  throw new Error('Set SURFGATE_API_KEY and SURFGATE_SESSION_ID before running this example.')
}
if (!['extract', 'screenshot', 'pdf'].includes(taskType)) {
  throw new Error('SURFGATE_TASK_TYPE must be extract, screenshot, or pdf.')
}

const auth = { Authorization: `Bearer ${apiKey}` }
const createdResponse = await fetch(
  `${apiURL}/v1/sessions/${encodeURIComponent(sessionId)}/tasks`,
  {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': 'application/json',
      'Idempotency-Key': `example-${randomUUID()}`,
    },
    body: JSON.stringify({ type: taskType }),
  },
)
if (!createdResponse.ok)
  throw new Error(`Task creation failed with HTTP ${createdResponse.status}.`)
let task = (await createdResponse.json()).task
if (typeof task?.id !== 'string') throw new Error('Response did not contain a task ID.')

while (['queued', 'running', 'retry_pending'].includes(task.status)) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  const response = await fetch(`${apiURL}/v1/tasks/${encodeURIComponent(task.id)}`, {
    headers: auth,
  })
  if (!response.ok) throw new Error(`Task read failed with HTTP ${response.status}.`)
  task = (await response.json()).task
}

console.log(JSON.stringify(task, null, 2))
const artifactId = task?.result?.artifact?.id
if (typeof artifactId === 'string') {
  const response = await fetch(`${apiURL}/v1/artifacts/${encodeURIComponent(artifactId)}`, {
    headers: auth,
  })
  if (!response.ok) throw new Error(`Artifact download failed with HTTP ${response.status}.`)
  const extension =
    task.type === 'pdf' ? 'pdf' : task.result.artifact.mediaType === 'image/jpeg' ? 'jpg' : 'png'
  const output = `surfgate-${artifactId}.${extension}`
  await writeFile(output, new Uint8Array(await response.arrayBuffer()), { flag: 'wx' })
  console.log(`Saved ${output}.`)
}
