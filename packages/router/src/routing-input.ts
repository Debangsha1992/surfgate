import {
  CapabilityRequirementsSchema,
  RequestIDSchema,
  RoutingDecisionIDSchema,
  RuntimePreferenceSchema,
  RuntimeSelectionSchema,
  TenantIDSchema,
} from '@surfgate/contracts'
import { ProviderIDSchema, RuntimeClassSchema } from '@surfgate/provider-core'
import { z } from 'zod'

import {
  RoutingCandidateIDSchema,
  RoutingInputSourceSchema,
  createRoutingCandidateID,
} from './candidate.js'

const MAX_SESSION_DURATION_MS = 24 * 60 * 60 * 1_000
const CandidateScoreSignalSchema = z
  .object({
    candidateID: RoutingCandidateIDSchema,
    score: z.number().int().finite().min(0).max(100),
  })
  .strict()
  .readonly()

const CandidateScoreSignalsSchema = z
  .array(CandidateScoreSignalSchema)
  .max(64)
  .default([])
  .readonly()

export const RoutingSignalsSchema = z
  .object({
    compatibility: CandidateScoreSignalsSchema,
    efficiency: CandidateScoreSignalsSchema,
    latency: CandidateScoreSignalsSchema,
  })
  .strict()
  .readonly()
export type RoutingSignals = z.infer<typeof RoutingSignalsSchema>

function uniqueArray<Schema extends z.ZodType>(schema: Schema) {
  return z
    .array(schema)
    .max(64)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: 'custom', message: 'Policy values must be unique.' })
      }
    })
    .readonly()
}

export const TenantRoutingPolicySchema = z
  .object({
    allowedProviderIDs: uniqueArray(ProviderIDSchema).optional(),
    deniedProviderIDs: uniqueArray(ProviderIDSchema).default([]),
    allowedRuntimeClasses: uniqueArray(RuntimeClassSchema).optional(),
    deniedRuntimeClasses: uniqueArray(RuntimeClassSchema).default([]),
    preferredRuntime: RuntimePreferenceSchema.default('auto'),
    maximumSessionDurationMs: z
      .number()
      .int()
      .finite()
      .min(1_000)
      .max(MAX_SESSION_DURATION_MS)
      .optional(),
    allowDegradedProviders: z.boolean().default(true),
    allowFallback: z.boolean().default(true),
    allowExperimental: z.boolean().default(true),
  })
  .strict()
  .readonly()
export type TenantRoutingPolicy = z.infer<typeof TenantRoutingPolicySchema>

export const RoutingInputSchema = z
  .object({
    decisionID: RoutingDecisionIDSchema,
    tenantID: TenantIDSchema,
    requestID: RequestIDSchema,
    createdAt: z.iso.datetime({ offset: true }),
    capabilityRegistryVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u),
    requirements: CapabilityRequirementsSchema,
    runtime: RuntimeSelectionSchema,
    maxSessionDurationMs: z.number().int().finite().min(1_000).max(MAX_SESSION_DURATION_MS),
    tenantPolicy: TenantRoutingPolicySchema.default(TenantRoutingPolicySchema.parse({})),
    candidateSources: z.array(RoutingInputSourceSchema).min(1).max(64).readonly(),
    signals: RoutingSignalsSchema.default(RoutingSignalsSchema.parse({})),
  })
  .strict()
  .superRefine((input, context) => {
    const candidateIDs = input.candidateSources.map((source) =>
      createRoutingCandidateID(source.descriptor),
    )
    const knownCandidateIDs = new Set(candidateIDs)
    if (knownCandidateIDs.size !== candidateIDs.length) {
      context.addIssue({
        code: 'custom',
        message: 'Candidate source identities must be unique.',
        path: ['candidateSources'],
      })
    }

    for (const [signalName, signals] of Object.entries(input.signals)) {
      const seen = new Set<string>()
      for (const [index, signal] of signals.entries()) {
        if (!knownCandidateIDs.has(signal.candidateID)) {
          context.addIssue({
            code: 'custom',
            message: 'Signals must reference a known candidate.',
            path: ['signals', signalName, index, 'candidateID'],
          })
        }
        if (seen.has(signal.candidateID)) {
          context.addIssue({
            code: 'custom',
            message: 'Each signal type may contain one value per candidate.',
            path: ['signals', signalName, index, 'candidateID'],
          })
        }
        seen.add(signal.candidateID)
      }
    }
  })
  .readonly()
export type RoutingInput = z.infer<typeof RoutingInputSchema>
