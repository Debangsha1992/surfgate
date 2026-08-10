import { describe, expect, it } from 'vitest'

import { TargetPolicyError, createTargetPolicy, redactSensitiveData } from '../src/index.js'

describe('deterministic adversarial security regression', () => {
  it('fails closed for generated malformed and unsupported target schemes', async () => {
    const policy = createTargetPolicy({ resolve: () => Promise.resolve(['93.184.216.34']) })
    const targets = [
      '',
      'not-a-url',
      'javascript:alert(1)',
      'data:text/plain,secret',
      'file:///etc/passwd',
      'ftp://example.com/file',
      'gopher://127.0.0.1/',
      'https://user:password@example.com/',
      ...Array.from({ length: 32 }, (_value, index) => `custom${index}://example.com/`),
    ]

    for (const target of targets) {
      await expect(policy.validate(target)).rejects.toBeInstanceOf(TargetPolicyError)
    }
  })

  it('redacts generated case and separator variants of authorization fields', () => {
    const variants = [
      'authorization',
      'Authorization',
      'AUTHORIZATION',
      'proxy-authorization',
      'proxy_authorization',
      'relay-token',
      'provider_session_reference_encrypted',
    ]
    const input = Object.fromEntries(variants.map((key) => [key, `secret-for-${key}`]))
    const serialized = JSON.stringify(redactSensitiveData(input))

    expect(serialized).not.toContain('secret-for-')
    expect(Object.values(redactSensitiveData(input))).toEqual(variants.map(() => '[REDACTED]'))
  })
})
