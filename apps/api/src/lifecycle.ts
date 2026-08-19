export async function completeAPIShutdown(
  dependencies: Readonly<{
    closeServer(): Promise<void>
    shutdownTelemetry(): Promise<void>
    forceExit(code: number): void
    warn(): void
  }>,
): Promise<void> {
  const serverClosure = await dependencies.closeServer().then(
    () => 'completed' as const,
    () => 'failed' as const,
  )
  if (serverClosure === 'failed') dependencies.warn()
  await dependencies.shutdownTelemetry()
  if (serverClosure === 'failed') dependencies.forceExit(1)
}
