import { loadReconciliationConfig } from '@surfgate/config'
import { createTelemetryRuntime } from '@surfgate/observability'
import { createChromiumBrowserProvider } from '@surfgate/provider-chromium'
import { createKitesurfBrowserProvider } from '@surfgate/provider-kitesurf'
import { createProviderSessionReferenceProtector } from '@surfgate/security'

import { createDatabase } from './database/database.js'
import { PostgresSessionRepository } from './database/postgres-session-repository.js'
import { ProviderRegistry } from './providers/provider-registry.js'
import { SessionReconciler } from './reconciliation/session-reconciler.js'

async function main(): Promise<void> {
  const config = loadReconciliationConfig()
  const observability = createTelemetryRuntime(config.telemetry, 'reconciler')
  const encryption = config.security.providerSessionEncryption
  if (encryption === undefined) throw new Error('Session reconciliation security is incomplete.')
  const database = createDatabase(config.database)
  try {
    const reconciler = new SessionReconciler({
      sessions: new PostgresSessionRepository(database),
      registry: new ProviderRegistry([
        createKitesurfBrowserProvider(config.cloudflare),
        createChromiumBrowserProvider(config.cloudflare),
      ]),
      protector: createProviderSessionReferenceProtector(encryption),
      staleAfterMs: config.controlPlane.reconciliationStaleAfterMs,
      batchSize: config.controlPlane.reconciliationBatchSize,
      terminationTimeoutMs: config.controlPlane.terminationTimeoutMs,
    })
    const result = await reconciler.runBatch()
    observability.controlPlane.recordSessionReconciliation?.({
      outcome: 'recovered',
      count: result.recovered,
    })
    observability.controlPlane.recordSessionReconciliation?.({
      outcome: 'unresolved',
      count: result.unresolved,
    })
    observability.controlPlane.recordSessionReconciliation?.({
      outcome: 'suspected_provider_leak',
      count: result.suspectedProviderLeaks,
    })
    process.stdout.write(
      `${JSON.stringify({ event: 'session.reconciliation.complete', ...result })}\n`,
    )
    if (result.unresolved > 0) process.exitCode = 1
  } finally {
    await database.close()
    await observability.shutdown()
  }
}

export function validateReconciliationConfiguration(): void {
  loadReconciliationConfig()
}

const validateOnly = process.argv.includes('--validate-config')
void (validateOnly ? Promise.resolve(validateReconciliationConfiguration()) : main()).catch(() => {
  process.stderr.write(
    '{"service":"surfgate-reconciler","level":"error","event":"session.reconciliation.failed"}\n',
  )
  process.exitCode = 1
})
