export type EnvironmentSource = Readonly<Record<string, string | undefined>>

export type RuntimeEnvironment = 'development' | 'test' | 'production'
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export type RuntimeConfig = Readonly<{
  environment: RuntimeEnvironment
  logLevel: LogLevel
}>

export type APIConfig = Readonly<{
  host: string
  port: number
}>

export type RelayConfig = Readonly<{
  host: string
  port: number
  publicURL: URL
  tokenTTLSeconds: number
  connectTimeoutMs: number
  idleTimeoutMs: number
  absoluteTimeoutMs: number
  maxMessageBytes: number
  maxQueuedBytes: number
  leaseTTLms: number
  authorizationCheckIntervalMs: number
  drainTimeoutMs: number
}>

export type DatabaseConfig = Readonly<{
  url: URL
  testURL: URL | undefined
}>

export type ProviderSessionEncryptionConfig = Readonly<{
  key: KeyObject
  keyID: string
}>

export type RelayTokenSigningConfig = Readonly<{
  key: KeyObject
  keyID: string
}>

export type SecurityConfig = Readonly<{
  providerSessionEncryption: ProviderSessionEncryptionConfig | undefined
  relayTokenSigning: RelayTokenSigningConfig | undefined
}>

export type RedisConfig = Readonly<{
  url: URL
}>

export type ControlPlaneConfig = Readonly<{
  healthTimeoutMs: number
  allocationTimeoutMs: number
  terminationTimeoutMs: number
  idempotencyWaitTimeoutMs: number
  quotas: Readonly<{
    requestsPerMinute: number
    maxConcurrentSessions: number
    maxSessionDurationSeconds: number
  }>
}>

export type ObjectStorageCredentials = Readonly<{
  accessKeyID: string
  secretAccessKey: string
}>

export type ObjectStorageConfig = Readonly<{
  region: string
  bucket: string
  endpoint: URL | undefined
  credentials: ObjectStorageCredentials | undefined
}>

export type ManagedTaskConfig = Readonly<{
  requestsPerMinute: number
  maxQueuedPerTenant: number
  maxRunningPerTenant: number
  maxAttempts: number
  executionTimeoutMs: number
  leaseTTLms: number
  pollIntervalMs: number
  extractMaxBytes: number
  artifactMaxBytes: number
  screenshotMaxPixels: number
  artifactRetentionSeconds: number
}>

export type TelemetryConfig = Readonly<{
  serviceName: string
  endpoint: URL | undefined
}>

export type CloudflareCredentials = Readonly<{
  accountID: string
  browserRunAPIToken: string
}>

export type CloudflareConfig = Readonly<{
  apiBaseURL: URL
  credentials: CloudflareCredentials | undefined
}>

export type SurfGateConfig = Readonly<{
  runtime: RuntimeConfig
  api: APIConfig
  relay: RelayConfig
  database: DatabaseConfig
  redis: RedisConfig
  objectStorage: ObjectStorageConfig
  tasks: ManagedTaskConfig
  telemetry: TelemetryConfig
  cloudflare: CloudflareConfig
  security: SecurityConfig
  controlPlane: ControlPlaneConfig
}>
import type { KeyObject } from 'node:crypto'
