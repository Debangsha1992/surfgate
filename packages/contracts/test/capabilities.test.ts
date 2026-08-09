import { describe, expect, it } from 'vitest'

import {
  CapabilityNameSchema,
  CapabilityRequirementsSchema,
  CapabilitySupportMapSchema,
  CapabilitySupportStateSchema,
  RuntimeSelectionSchema,
  satisfiesCapabilityRequirement,
} from '../src/index.js'

const COMPLETE_SUPPORT_MAP = {
  javascript: 'supported',
  dom: 'supported',
  xhr: 'supported',
  svg: 'supported',
  screenshot: 'supported',
  pdf: 'experimental',
  webgl: 'unsupported',
  video: 'unsupported',
  persistentAuth: 'experimental',
  realBrowserTLS: 'unknown',
  downloads: 'experimental',
  uploads: 'experimental',
  multiTab: 'supported',
  longSession: 'unknown',
} as const

describe('browser capability contracts', () => {
  it('accepts the documented provider-neutral capability names', () => {
    expect(CapabilityNameSchema.options).toEqual([
      'javascript',
      'dom',
      'xhr',
      'svg',
      'screenshot',
      'pdf',
      'webgl',
      'video',
      'persistentAuth',
      'realBrowserTLS',
      'downloads',
      'uploads',
      'multiTab',
      'longSession',
    ])
  })

  it.each([
    ['supported', 'required', false, true],
    ['unsupported', 'required', false, false],
    ['unknown', 'required', false, false],
    ['experimental', 'required', false, false],
    ['experimental', 'required', true, true],
  ] as const)(
    'evaluates %s support for a %s capability when experimental=%s',
    (support, requirement, allowExperimental, expected) => {
      expect(satisfiesCapabilityRequirement(support, requirement, allowExperimental)).toBe(expected)
    },
  )

  it.each(['supported', 'unsupported', 'experimental', 'unknown'] as const)(
    'does not reject a preferred capability with %s support',
    (support) => {
      expect(satisfiesCapabilityRequirement(support, 'preferred', false)).toBe(true)
    },
  )

  it.each(['supported', 'unsupported', 'experimental', 'unknown'] as const)(
    'ignores a not_required capability with %s support',
    (support) => {
      expect(satisfiesCapabilityRequirement(support, 'not_required', false)).toBe(true)
    },
  )

  it('validates an exhaustive capability support map and partial requirement map', () => {
    expect(CapabilitySupportMapSchema.parse(COMPLETE_SUPPORT_MAP)).toEqual(COMPLETE_SUPPORT_MAP)
    expect(
      CapabilityRequirementsSchema.parse({
        javascript: 'required',
        screenshot: 'preferred',
        video: 'not_required',
      }),
    ).toEqual({
      javascript: 'required',
      screenshot: 'preferred',
      video: 'not_required',
    })
  })

  it('rejects a support map that omits a capability instead of declaring unknown', () => {
    const incompleteSupportMap = Object.fromEntries(
      Object.entries(COMPLETE_SUPPORT_MAP).filter(([name]) => name !== 'webgl'),
    )

    expect(CapabilitySupportMapSchema.safeParse(incompleteSupportMap).success).toBe(false)
  })

  it('rejects an invalid capability name', () => {
    expect(CapabilityRequirementsSchema.safeParse({ browserStealth: 'required' }).success).toBe(
      false,
    )
  })

  it('rejects an invalid support state', () => {
    expect(CapabilitySupportStateSchema.safeParse('partial').success).toBe(false)
    expect(CapabilitySupportMapSchema.safeParse({ javascript: 'partial' }).success).toBe(false)
  })

  it('validates runtime selection policy flags', () => {
    expect(
      RuntimeSelectionSchema.parse({
        preference: 'auto',
        allowFallback: true,
        allowExperimental: false,
      }),
    ).toEqual({
      preference: 'auto',
      allowFallback: true,
      allowExperimental: false,
    })
  })

  it('rejects an invalid runtime preference', () => {
    expect(
      RuntimeSelectionSchema.safeParse({
        preference: 'firefox',
        allowFallback: true,
        allowExperimental: false,
      }).success,
    ).toBe(false)
  })
})
