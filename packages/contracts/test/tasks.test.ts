import { describe, expect, it } from 'vitest'

import {
  ManagedTaskCreateRequestSchema,
  ManagedTaskSchema,
  PublicArtifactSchema,
} from '../src/index.js'

const TASK_ID = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SESSION_ID = 'ses_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const ARTIFACT_ID = 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('managed task contracts', () => {
  it.each([
    { type: 'extract' },
    { type: 'extract', selector: 'main' },
    { type: 'screenshot', format: 'png', fullPage: true },
    { type: 'screenshot', format: 'jpeg', quality: 80 },
    { type: 'pdf', landscape: true, printBackground: false },
  ])('accepts provider-neutral task request %#', (request) => {
    expect(ManagedTaskCreateRequestSchema.parse(request)).toMatchObject(request)
  })

  it.each([
    { type: 'javascript', source: 'document.cookie' },
    { type: 'extract', selector: '' },
    { type: 'screenshot', format: 'gif' },
    { type: 'screenshot', format: 'png', quality: 80 },
    { type: 'pdf', widthInches: 100 },
  ])('rejects invalid or unsafe request %#', (request) => {
    expect(ManagedTaskCreateRequestSchema.safeParse(request).success).toBe(false)
  })

  it('validates a bounded public extract result', () => {
    const parsed = ManagedTaskSchema.parse({
      id: TASK_ID,
      sessionId: SESSION_ID,
      type: 'extract',
      status: 'succeeded',
      attemptCount: 1,
      result: { type: 'extract', title: 'Example', text: 'Hello' },
      failureCode: null,
      createdAt: '2026-08-10T00:00:00.000Z',
      startedAt: '2026-08-10T00:00:01.000Z',
      completedAt: '2026-08-10T00:00:02.000Z',
      failedAt: null,
      nextAttemptAt: null,
    })

    expect(parsed.result).toEqual({ type: 'extract', title: 'Example', text: 'Hello' })
  })

  it('never includes an internal storage key in public artifact metadata', () => {
    const artifact = PublicArtifactSchema.parse({
      id: ARTIFACT_ID,
      mediaType: 'image/png',
      byteSize: 42,
      sha256: 'a'.repeat(64),
      createdAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-11T00:00:00.000Z',
    })

    expect(artifact).not.toHaveProperty('storageKey')
    expect(() => PublicArtifactSchema.parse({ ...artifact, storageKey: 'private/key' })).toThrow()
  })
})
