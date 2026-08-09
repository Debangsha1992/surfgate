import { CapabilitySupportMapSchema } from '@surfgate/contracts'
import {
  ProviderDescriptorSchema,
  ProviderHealthSchema,
  ProviderIDSchema,
  RuntimeClassSchema,
  type ProviderDescriptor,
} from '@surfgate/provider-core'
import { z } from 'zod'

const MAX_SESSION_DURATION_MS = 24 * 60 * 60 * 1_000

export const RoutingCandidateIDSchema = z
  .string()
  .min(1)
  .max(2_048)
  .regex(/^[A-Za-z0-9%._:=-]+$/u)
  .brand<'RoutingCandidateID'>()
export type RoutingCandidateID = z.infer<typeof RoutingCandidateIDSchema>

export const CandidateSafetySchema = z
  .object({
    status: z.enum(['allowed', 'blocked']).default('allowed'),
    maximumSessionDurationMs: z
      .number()
      .int()
      .finite()
      .min(1_000)
      .max(MAX_SESSION_DURATION_MS)
      .optional(),
  })
  .strict()
  .readonly()
export type CandidateSafety = z.infer<typeof CandidateSafetySchema>

export const RoutingInputSourceSchema = z
  .object({
    descriptor: ProviderDescriptorSchema,
    health: ProviderHealthSchema,
    safety: CandidateSafetySchema.default({ status: 'allowed' }),
  })
  .strict()
  .readonly()
export type RoutingInputSource = z.infer<typeof RoutingInputSourceSchema>

export const RoutingCandidateSchema = z
  .object({
    candidateID: RoutingCandidateIDSchema,
    providerID: ProviderIDSchema,
    runtimeClass: RuntimeClassSchema,
    region: z.string().trim().min(1).max(64).optional(),
    configProfile: z.string().trim().min(1).max(64).optional(),
    configured: z.boolean(),
    capabilities: CapabilitySupportMapSchema,
    health: ProviderHealthSchema,
    safety: CandidateSafetySchema,
  })
  .strict()
  .readonly()
export type RoutingCandidate = z.infer<typeof RoutingCandidateSchema>

const RoutingCandidateIdentityComponentsSchema = z
  .object({
    providerID: ProviderIDSchema,
    runtimeClass: RuntimeClassSchema,
    region: z.string().trim().min(1).max(64).optional(),
    configProfile: z.string().trim().min(1).max(64).optional(),
  })
  .strict()

function encodeURIComponentCharacter(value: string): string {
  return encodeURIComponent(value).replaceAll(
    /[!'()*~]/gu,
    (character) => `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? ''}`,
  )
}

function encodePresentComponent(value: string): string {
  let encoded = ''
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    const nextCodeUnit = value.charCodeAt(index + 1)
    if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      nextCodeUnit >= 0xdc00 &&
      nextCodeUnit <= 0xdfff
    ) {
      encoded += encodeURIComponentCharacter(value.slice(index, index + 2))
      index += 1
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
      encoded += `%u${codeUnit.toString(16).toUpperCase().padStart(4, '0')}`
    } else {
      encoded += encodeURIComponentCharacter(value[index]!)
    }
  }
  return `=${encoded}`
}

function encodeOptionalComponent(value: string | undefined): string {
  return value === undefined ? '-' : encodePresentComponent(value)
}

export function createRoutingCandidateID(descriptor: ProviderDescriptor): RoutingCandidateID {
  const validated = ProviderDescriptorSchema.parse(descriptor)
  return createRoutingCandidateIDFromIdentity({
    providerID: validated.providerID,
    runtimeClass: validated.runtimeClass,
    ...(validated.region === undefined ? {} : { region: validated.region }),
    ...(validated.configProfile === undefined ? {} : { configProfile: validated.configProfile }),
  })
}

export function createRoutingCandidateIDFromIdentity(
  rawIdentity: z.input<typeof RoutingCandidateIdentityComponentsSchema>,
): RoutingCandidateID {
  const identity = RoutingCandidateIdentityComponentsSchema.parse(rawIdentity)
  return RoutingCandidateIDSchema.parse(
    [
      identity.providerID,
      identity.runtimeClass,
      encodeOptionalComponent(identity.region),
      encodeOptionalComponent(identity.configProfile),
    ].join('::'),
  )
}

export function buildRoutingCandidates(
  sources: readonly RoutingInputSource[],
): readonly RoutingCandidate[] {
  const validatedSources = z.array(RoutingInputSourceSchema).min(1).max(64).parse(sources)
  const candidates = validatedSources.map((source) =>
    RoutingCandidateSchema.parse({
      candidateID: createRoutingCandidateID(source.descriptor),
      providerID: source.descriptor.providerID,
      runtimeClass: source.descriptor.runtimeClass,
      ...(source.descriptor.region === undefined ? {} : { region: source.descriptor.region }),
      ...(source.descriptor.configProfile === undefined
        ? {}
        : { configProfile: source.descriptor.configProfile }),
      configured: source.descriptor.configured && source.health.configured,
      capabilities: source.descriptor.capabilities,
      health: source.health,
      safety: source.safety,
    }),
  )

  const uniqueIDs = new Set(candidates.map((candidate) => candidate.candidateID))
  if (uniqueIDs.size !== candidates.length) {
    throw new Error('Routing candidate identities must be unique.')
  }

  return Object.freeze(
    candidates.toSorted((left, right) =>
      left.candidateID < right.candidateID ? -1 : left.candidateID > right.candidateID ? 1 : 0,
    ),
  )
}
