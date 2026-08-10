const REDACTED = '[REDACTED]'
const CIRCULAR = '[Circular]'

const SENSITIVE_KEYS = new Set([
  'accesskeyid',
  'apikey',
  'apikeyhash',
  'authorization',
  'browserrunapitoken',
  'clientsecret',
  'cloudflarebrowserrunapitoken',
  'connectionstring',
  'cookie',
  'credentials',
  'databaseurl',
  'idempotencykey',
  'jwt',
  'key',
  'keyhash',
  'password',
  'paseto',
  'privatekey',
  'providersessionreference',
  'providersessionreferenceencrypted',
  'proxyauthorization',
  'refreshtoken',
  'relaytoken',
  'secret',
  'secretaccesskey',
  'sessiontoken',
  'setcookie',
  'signingkey',
  'surfgateprovidersessionencryptionkey',
  'surfgaterelaytokensigningkey',
  'token',
  'xapikey',
])

const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'key',
  'password',
  'refresh_token',
  'secret',
  'signature',
  'token',
])
const SECRET_QUERY_VALUE_PATTERN =
  /([?&](?:access_token|api_key|apikey|auth|authorization|key|password|refresh_token|secret|signature|token)=)[^&#\s]*/giu

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, '')
}

function redactString(value: string): string {
  const sanitized = [
    /\b(?:basic|bearer)\s+\S+/giu,
    /sg_(?:live|test)_[0-9a-f]{12}_[A-Za-z0-9_-]{43}/gu,
    /sgrt\.v1\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}/gu,
    /psr\.v1\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}/gu,
  ]
    .reduce((current, pattern) => current.replace(pattern, REDACTED), value)
    .replace(SECRET_QUERY_VALUE_PATTERN, `$1${REDACTED}`)
  if (!URL.canParse(sanitized)) return sanitized
  const url = new URL(sanitized)
  if (url.username.length > 0 || url.password.length > 0) return REDACTED
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.set(key, REDACTED)
  }
  return url.href
}

function visit(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return CIRCULAR
  seen.add(value)
  if (Array.isArray(value)) return value.map((entry) => visit(entry, seen))
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) }
  }
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SENSITIVE_KEYS.has(normalizedKey(key)) ? REDACTED : visit(entry, seen)
  }
  return output
}

/** Returns a recursively sanitized copy suitable for structured logs and audit boundaries. */
export function redactSensitiveData(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>>
export function redactSensitiveData(value: unknown): unknown
export function redactSensitiveData(value: unknown): unknown {
  return visit(value, new WeakSet())
}

export const SENSITIVE_LOG_PATHS = Object.freeze([
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.proxy-authorization',
  'req.headers.x-api-key',
  'res.headers.set-cookie',
  'headers.authorization',
  'headers.cookie',
  'headers.proxy-authorization',
  'headers.set-cookie',
  'headers.x-api-key',
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'apiKey',
  'relayToken',
  'providerSessionReferenceEncrypted',
  'browserRunAPIToken',
  'password',
])
