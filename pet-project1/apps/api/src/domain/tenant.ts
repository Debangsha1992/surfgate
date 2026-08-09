import { TenantIDSchema } from '@surfgate/contracts'
import { z } from 'zod'

export const TENANT_STATUSES = ['active', 'suspended', 'disabled'] as const
export const TenantStatusSchema = z.enum(TENANT_STATUSES)
export type TenantStatus = z.infer<typeof TenantStatusSchema>

export const TenantSchema = z
  .object({
    id: TenantIDSchema,
    name: z.string().trim().min(1).max(200),
    status: TenantStatusSchema,
    plan: z.string().trim().min(1).max(64),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((tenant) => Date.parse(tenant.updatedAt) >= Date.parse(tenant.createdAt), {
    message: 'Tenant update time cannot precede creation.',
    path: ['updatedAt'],
  })
  .readonly()
export type Tenant = z.infer<typeof TenantSchema>
