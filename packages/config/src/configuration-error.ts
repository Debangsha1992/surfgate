export const CONFIGURATION_ERROR_CODE = 'CONFIGURATION_INVALID' as const

export type ConfigurationIssue = Readonly<{
  key: string
  message: string
}>

export class ConfigurationError extends Error {
  readonly code = CONFIGURATION_ERROR_CODE
  readonly issues: readonly ConfigurationIssue[]

  constructor(issues: readonly ConfigurationIssue[]) {
    const sanitizedIssues = issues.map((issue) => Object.freeze({ ...issue }))
    super(
      `Invalid SurfGate configuration: ${sanitizedIssues
        .map((issue) => `${issue.key}: ${issue.message}`)
        .join('; ')}`,
    )
    this.name = 'ConfigurationError'
    this.issues = Object.freeze(sanitizedIssues)
  }
}
