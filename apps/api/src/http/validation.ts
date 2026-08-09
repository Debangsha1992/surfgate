import type { output, ZodType } from 'zod'

export function validatePublicResponse<Schema extends ZodType>(
  schema: Schema,
  value: unknown,
): output<Schema> {
  return schema.parse(value)
}
