import { context, trace } from '@opentelemetry/api'
import { redactSensitiveData } from '@surfgate/security'

export type StructuredLogger = Readonly<{
  info(fields: Readonly<Record<string, unknown>>, message: string): void
  warn(fields: Readonly<Record<string, unknown>>, message: string): void
  error(fields: Readonly<Record<string, unknown>>, message: string): void
}>

export function createStructuredLogger(
  input: Readonly<{
    service: string
    environment: string
    write?: (line: string) => void
    writeError?: (line: string) => void
  }>,
): StructuredLogger {
  const write = input.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const writeError = input.writeError ?? ((line: string) => process.stderr.write(`${line}\n`))
  const emit = (
    level: 'info' | 'warn' | 'error',
    fields: Readonly<Record<string, unknown>>,
    message: string,
  ): void => {
    const spanContext = trace.getSpanContext(context.active())
    const safe = redactSensitiveData(fields)
    const redactedMessage = redactSensitiveData(message)
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      service: input.service,
      environment: input.environment,
      level,
      message: typeof redactedMessage === 'string' ? redactedMessage : 'Log message redacted.',
      ...(spanContext === undefined ? {} : { traceID: spanContext.traceId }),
      ...safe,
    })
    ;(level === 'error' ? writeError : write)(line)
  }
  return Object.freeze({
    info: (fields, message) => emit('info', fields, message),
    warn: (fields, message) => emit('warn', fields, message),
    error: (fields, message) => emit('error', fields, message),
  })
}
