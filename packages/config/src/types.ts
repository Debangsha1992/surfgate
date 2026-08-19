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
  requiredMigration: string
}>

export type DatabaseMigrationConfig = Readonly<{
  database: DatabaseConfig
}>

export type SymmetricKeyConfig = Readonly<{
  key: KeyObject
  keyID: string
}>

export type ProviderSessionEncryptionConfig = SymmetricKeyConfig &
  Readonly<{ decryptionKeys: readonly SymmetricKeyConfig[] }>

export type RelayTokenSigningConfig = SymmetricKeyConfig &
  Readonly<{ verificationKeys: readonly SymmetricKeyConfig[] }>

export type RawCDPAccess = 'disabled' | 'trusted'

export type SecurityConfig = Readonly<{
  providerSessionEncryption: ProviderSessionEncryptionConfig | undefined
  relayTokenSigning: RelayTokenSigningConfig | undefined
  rawCDPAccess: RawCDPAccess
}>

export type RedisConfig = Readonly<{
  url: URL
}>

export type ControlPlaneConfig = Readonly<{
  healthTimeoutMs: number
  allocationTimeoutMs: number
  terminationTimeoutMs: number
  idempotencyWaitTimeoutMs: number
  reconciliationStaleAfterMs: number
  reconciliationBatchSize: number
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

export type WorkerConfig = Readonly<{
  healthHost: string
  healthPort: number
  readinessTimeoutMs: number
  drainTimeoutMs: number
}>

export type TelemetryConfig = Readonly<{
  serviceName: string
  endpoint: URL | undefined
  exportIntervalMs: number
  exportTimeoutMs: number
  shutdownTimeoutMs: number
  maxQueueSize: number
  maxExportBatchSize: number
  metricCardinalityLimit: number
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
  worker: WorkerConfig
  telemetry: TelemetryConfig
  cloudflare: CloudflareConfig
  security: SecurityConfig
  controlPlane: ControlPlaneConfig
}>

export type ReconciliationConfig = Pick<
  SurfGateConfig,
  'cloudflare' | 'controlPlane' | 'database' | 'runtime' | 'security' | 'telemetry'
>

export type RelayServiceConfig = Pick<
  SurfGateConfig,
  'cloudflare' | 'database' | 'redis' | 'relay' | 'runtime' | 'security' | 'telemetry'
>

export type WorkerServiceConfig = Pick<
  SurfGateConfig,
  | 'cloudflare'
  | 'database'
  | 'objectStorage'
  | 'runtime'
  | 'security'
  | 'tasks'
  | 'telemetry'
  | 'worker'
>
import type { KeyObject } from 'node:crypto'
