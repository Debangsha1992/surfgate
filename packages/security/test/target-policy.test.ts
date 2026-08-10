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
    'http://localhost./',
    'http://127.1/',
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://0x7f000001/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::]/',
  ])('fails closed for forbidden target %s', async (target) => {
    const policy = createTargetPolicy({ resolve: () => Promise.resolve(['93.184.216.34']) })
    await expect(policy.validate(target)).rejects.toBeInstanceOf(TargetPolicyError)
  })

  it.each([
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '127.255.255.255',
    '169.254.169.254',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ])('rejects a hostname resolving to special-use address %s', async (address) => {
    const policy = createTargetPolicy({ resolve: () => Promise.resolve([address]) })
    await expect(policy.validate('https://example.com')).rejects.toBeInstanceOf(TargetPolicyError)
  })

  it('normalizes trailing dots and internationalized hostnames before resolution', async () => {
    const resolve = vi.fn(() => Promise.resolve(['93.184.216.34']))
    const policy = createTargetPolicy({ resolve })

    await expect(policy.validate('https://BÜCHER.example./path')).resolves.toBe(
      'https://xn--bcher-kva.example/path',
    )
    expect(resolve).toHaveBeenCalledWith('xn--bcher-kva.example')
  })

  it('rejects excessive DNS answers', async () => {
    const policy = createTargetPolicy({
      maxAddresses: 2,
      resolve: () => Promise.resolve(['93.184.216.34', '8.8.8.8', '1.1.1.1']),
    })
    await expect(policy.validate('https://example.com')).rejects.toBeInstanceOf(TargetPolicyError)
  })

  it('rejects DNS rebinding when repeated resolution changes the destination set', async () => {
    const resolve = vi
      .fn<() => Promise<readonly string[]>>()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['127.0.0.1'])
    const policy = createTargetPolicy({ resolve, resolutionPasses: 2 })

    await expect(policy.validate('https://example.com')).rejects.toBeInstanceOf(TargetPolicyError)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('accepts stable DNS sets independent of answer ordering', async () => {
    const resolve = vi
      .fn<() => Promise<readonly string[]>>()
      .mockResolvedValueOnce(['93.184.216.34', '1.1.1.1'])
      .mockResolvedValueOnce(['1.1.1.1', '93.184.216.34'])
    const policy = createTargetPolicy({ resolve, resolutionPasses: 2 })

    await expect(policy.validate('https://example.com')).resolves.toBe('https://example.com/')
  })

  it('revalidates every redirect hop and rejects a public-to-private redirect', async () => {
    const policy = createTargetPolicy({
      resolve: (hostname) =>
        Promise.resolve(hostname === 'public.example' ? ['93.184.216.34'] : ['127.0.0.1']),
    })

    await expect(
      policy.validateRedirectChain([
        'https://public.example/start',
        'https://private.example/admin',
      ]),
    ).rejects.toBeInstanceOf(TargetPolicyError)
  })

  it('rejects a redirect from a public target to a cloud metadata address', async () => {
    const policy = createTargetPolicy({
      resolve: () => Promise.resolve(['93.184.216.34']),
    })

    await expect(
      policy.validateRedirectChain([
        'https://public.example/start',
        'http://169.254.169.254/latest/meta-data',
      ]),
    ).rejects.toBeInstanceOf(TargetPolicyError)
  })

  it('rejects redirect loops and excessive redirect chains', async () => {
    const policy = createTargetPolicy({
      maxRedirects: 2,
      resolve: () => Promise.resolve(['93.184.216.34']),
    })

    await expect(
      policy.validateRedirectChain(['https://a.example/', 'https://a.example/']),
    ).rejects.toBeInstanceOf(TargetPolicyError)
    await expect(
      policy.validateRedirectChain([
        'https://a.example/',
        'https://b.example/',
        'https://c.example/',
        'https://d.example/',
      ]),
    ).rejects.toBeInstanceOf(TargetPolicyError)
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
