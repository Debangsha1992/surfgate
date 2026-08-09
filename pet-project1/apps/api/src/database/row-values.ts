import { z } from 'zod'

export function timestampFromRow(value: unknown): string {
  const timestamp = value instanceof Date ? value.toISOString() : value
  return z.iso.datetime({ offset: true }).parse(timestamp)
}

export function optionalTimestampFromRow(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : timestampFromRow(value)
}

export function nullableTimestampFromRow(value: unknown): string | null {
  return value === null || value === undefined ? null : timestampFromRow(value)
}

export function safeIntegerFromRow(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  return z.number().int().safe().nonnegative().parse(parsed)
}
