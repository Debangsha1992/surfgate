import { SURFGATE_ERROR_MESSAGES, type SurfGateErrorCode } from '@surfgate/contracts'

export class ControlPlaneHTTPError extends Error {
  readonly code: SurfGateErrorCode
  readonly statusCode: number

  constructor(code: SurfGateErrorCode, statusCode: number) {
    super(SURFGATE_ERROR_MESSAGES[code])
    this.name = 'ControlPlaneHTTPError'
    this.code = code
    this.statusCode = statusCode
  }
}
