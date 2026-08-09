import { CapabilitySupportMapSchema } from '@surfgate/contracts'
import { z } from 'zod'

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u
const RUNTIME_CLASS_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u

export const ProviderIDSchema = z.string().regex(PROVIDER_ID_PATTERN).brand<'ProviderID'>()
export type ProviderID = z.infer<typeof ProviderIDSchema>

export const RuntimeClassSchema = z.string().regex(RUNTIME_CLASS_PATTERN).brand<'RuntimeClass'>()
export type RuntimeClass = z.infer<typeof RuntimeClassSchema>

export const ProviderImplementationSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    version: z.string().trim().min(1).max(64),
  })
  .strict()
  .readonly()
export type ProviderImplementation = z.infer<typeof ProviderImplementationSchema>

const ProviderLocationSchema = z.string().trim().min(1).max(64)

export const ProviderDescriptorSchema = z
  .object({
    providerID: ProviderIDSchema,
    runtimeClass: RuntimeClassSchema,
    displayName: z.string().trim().min(1).max(128),
    capabilities: CapabilitySupportMapSchema,
    implementation: ProviderImplementationSchema,
    region: ProviderLocationSchema.optional(),
    configProfile: ProviderLocationSchema.optional(),
    configured: z.boolean(),
  })
  .strict()
  .readonly()
export type ProviderDescriptor = z.infer<typeof ProviderDescriptorSchema>
