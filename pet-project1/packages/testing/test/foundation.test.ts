import { describe, expect, it } from 'vitest'

import { FOUNDATION_STATUS } from '../src/index.js'

describe('workspace foundation', () => {
  it('loads TypeScript source through Vitest', () => {
    expect(FOUNDATION_STATUS).toBe('workspace-ready')
  })
})
