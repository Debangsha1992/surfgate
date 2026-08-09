import { z } from 'zod'

export const CAPABILITY_NAMES = [
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
] as const

export const CapabilityNameSchema = z.enum(CAPABILITY_NAMES)
export type CapabilityName = z.infer<typeof CapabilityNameSchema>

export const CAPABILITY_SUPPORT_STATES = [
  'supported',
  'unsupported',
  'experimental',
  'unknown',
] as const

export const CapabilitySupportStateSchema = z.enum(CAPABILITY_SUPPORT_STATES)
export type CapabilitySupportState = z.infer<typeof CapabilitySupportStateSchema>

export const CAPABILITY_REQUIREMENT_STATES = ['required', 'preferred', 'not_required'] as const

export const CapabilityRequirementStateSchema = z.enum(CAPABILITY_REQUIREMENT_STATES)
export type CapabilityRequirementState = z.infer<typeof CapabilityRequirementStateSchema>

export const CapabilitySupportMapSchema = z
  .record(CapabilityNameSchema, CapabilitySupportStateSchema)
  .readonly()
export type CapabilitySupportMap = z.infer<typeof CapabilitySupportMapSchema>

export const CapabilityRequirementsSchema = z
  .partialRecord(CapabilityNameSchema, CapabilityRequirementStateSchema)
  .readonly()
export type CapabilityRequirements = z.infer<typeof CapabilityRequirementsSchema>

export const RUNTIME_PREFERENCES = ['auto', 'kitesurf', 'chromium'] as const

export const RuntimePreferenceSchema = z.enum(RUNTIME_PREFERENCES)
export type RuntimePreference = z.infer<typeof RuntimePreferenceSchema>

export const RuntimeSelectionSchema = z
  .object({
    preference: RuntimePreferenceSchema,
    allowFallback: z.boolean(),
    allowExperimental: z.boolean(),
  })
  .strict()
  .readonly()
export type RuntimeSelection = z.infer<typeof RuntimeSelectionSchema>

export function satisfiesCapabilityRequirement(
  support: CapabilitySupportState,
  requirement: CapabilityRequirementState,
  allowExperimental: boolean,
): boolean {
  if (requirement !== 'required') {
    return true
  }

  return support === 'supported' || (support === 'experimental' && allowExperimental)
}
