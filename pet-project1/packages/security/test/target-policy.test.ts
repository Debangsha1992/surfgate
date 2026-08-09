import { describe, expect, it, vi } from 'vitest'

import { TargetPolicyError, createTargetPolicy } from '../src/index.js'

describe('target URL security policy', () => {
  it('canonicalizes a public HTTPS target after all DNS answers pass', async () => {
    const policy = createTargetPolicy({
      resolve: vi.fn(() =>
        Promise.resolve(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']),
      ),
      timeoutMs: 50,
    })
    await expect(policy.validate('https://Example.COM/path')).resolves.toBe(
      'https://example.com/path',
    )
  })

  it.each([
    'file:///etc/passwd',
    'http://user:password@example.com',
    'http://localhost/',
    'http://service.internal/',
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://[fc00::1]/',
  ])('fails closed for forbidden target %s', async (target) => {
    const policy = createTargetPolicy({ resolve: () => Promise.resolve(['93.184.216.34']) })
    await expect(policy.validate(target)).rejects.toBeInstanceOf(TargetPolicyError)
  })

  it('rejects a hostname when any DNS answer is private', async () => {
    const policy = createTargetPolicy({
      resolve: () => Promise.resolve(['93.184.216.34', '10.0.0.7']),
    })
    await expect(policy.validate('https://example.com')).rejects.toBeInstanceOf(TargetPolicyError)
  })

  it('bounds DNS resolution and exposes no target details', async () => {
    vi.useFakeTimers()
    const policy = createTargetPolicy({
      resolve: () => new Promise<readonly string[]>(() => undefined),
      timeoutMs: 10,
    })
    try {
      const validation = policy
        .validate('https://secret.internal.example')
        .catch((caught: unknown) => caught)
      await vi.advanceTimersByTimeAsync(10)
      const error = await validation
      expect(error).toMatchObject({ code: 'POLICY_TARGET_FORBIDDEN' })
      expect(error instanceof Error ? error.message : '').not.toContain('secret.internal.example')
    } finally {
      vi.useRealTimers()
    }
  })
})
