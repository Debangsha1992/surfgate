import { z } from 'zod'

export const LivenessResponseSchema = z
  .object({ status: z.literal('alive') })
  .strict()
  .readonly()
export type LivenessResponse = z.infer<typeof LivenessResponseSchema>

export const ReadinessResponseSchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    dependencies: z
      .object({
        postgres: z.enum(['ready', 'unavailable']),
        redis: z.enum(['ready', 'unavailable']).optional(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly()
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>
