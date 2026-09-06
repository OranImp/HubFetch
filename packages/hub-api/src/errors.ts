import {
  HUB_CAPABILITY_ERROR_MARKER,
  type HubCapabilityErrorCode,
  type HubCapabilityKey,
  type HubCapabilitySourceClass
} from '@hubfetch/shared'

export class HubApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string
  ) {
    super(message)
    this.name = 'HubApiError'
  }
}

/**
 * A secret-free, capability-scoped error that can cross the Electron boundary.
 * The marker is intentionally closed and contains no URL, response text, or
 * request metadata; the renderer can recover the affected capability safely.
 */
export class HubCapabilityError extends HubApiError {
  readonly capability: HubCapabilityKey
  readonly code: HubCapabilityErrorCode

  constructor(
    capability: HubCapabilityKey,
    code: HubCapabilityErrorCode,
    message: string,
    status?: number
  ) {
    const marker = `[${HUB_CAPABILITY_ERROR_MARKER} key=${capability} code=${code}]`
    const sentinel = code === 'session-required' ? ' HUB_WEB_SESSION_REQUIRED' : ''
    super(`${message}${sentinel} ${marker}`, status)
    this.name = 'HubCapabilityError'
    this.capability = capability
    this.code = code
  }
}

const NETWORK_ERROR_RE =
  /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|timed? ?out|abort/i

const CAPABILITY_MESSAGES: Record<HubCapabilityErrorCode, string> = {
  'session-required': 'This Hub capability needs a web session.',
  unauthorized: 'This Hub capability needs an authorized token.',
  forbidden: 'The Hub denied this capability.',
  'rate-limited': 'The Hub is rate-limiting this capability.',
  'upstream-changed': 'The Hub compatibility contract for this capability changed.',
  network: 'The Hub capability could not reach its service.'
}

/** Map an arbitrary Hub failure to a closed, capability-scoped error code. */
export function toHubCapabilityError(
  capability: HubCapabilityKey,
  sourceClass: HubCapabilitySourceClass,
  error: unknown,
  contractFailure = false
): HubCapabilityError {
  if (error instanceof HubCapabilityError) return error
  if (error instanceof CookieRequiredError) {
    return new HubCapabilityError(capability, 'session-required', CAPABILITY_MESSAGES['session-required'])
  }
  if (error instanceof HubApiError) {
    switch (error.status) {
      case 401:
        return new HubCapabilityError(capability, 'unauthorized', CAPABILITY_MESSAGES.unauthorized, 401)
      case 403:
        return new HubCapabilityError(capability, 'forbidden', CAPABILITY_MESSAGES.forbidden, 403)
      case 429:
        return new HubCapabilityError(capability, 'rate-limited', CAPABILITY_MESSAGES['rate-limited'], 429)
      default:
        break
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (NETWORK_ERROR_RE.test(message)) {
    return new HubCapabilityError(capability, 'network', CAPABILITY_MESSAGES.network)
  }
  if (contractFailure || sourceClass === 'ssr-scrape' || sourceClass === 'datasets-server') {
    return new HubCapabilityError(
      capability,
      'upstream-changed',
      CAPABILITY_MESSAGES['upstream-changed']
    )
  }
  return new HubCapabilityError(capability, 'network', CAPABILITY_MESSAGES.network)
}

export function isHubCapabilityErrorCode(value: string): value is HubCapabilityErrorCode {
  return (
    value === 'session-required' ||
    value === 'unauthorized' ||
    value === 'forbidden' ||
    value === 'rate-limited' ||
    value === 'upstream-changed' ||
    value === 'network'
  )
}

/**
 * Thrown before any network I/O when a cookie-authenticated endpoint is called
 * without a Hub web session. Deliberately carries no HTTP status so
 * isUnauthorized/isTokenRejection never mistake it for a token-auth failure.
 * The message embeds HUB_WEB_SESSION_REQUIRED because Electron flattens errors
 * to their message string across IPC — the renderer matches on that sentinel.
 */
export class CookieRequiredError extends HubApiError {
  constructor(url?: string) {
    super('this action needs a Hub web session (HUB_WEB_SESSION_REQUIRED)', undefined, url)
    this.name = 'CookieRequiredError'
  }
}

export function isCookieRequired(err: unknown): boolean {
  return err instanceof CookieRequiredError
}

export function isNotFound(err: unknown): boolean {
  return err instanceof HubApiError && err.status === 404
}

/**
 * Definitive 401 only: the credential itself was rejected. 403s come from WAF
 * challenges, geo blocks, proxies, and gated repos — they must never be taken
 * as proof a token was revoked (see isForbidden).
 */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof HubApiError && err.status === 401
}

export function isForbidden(err: unknown): boolean {
  return err instanceof HubApiError && err.status === 403
}

/**
 * A definitive rejection from a token endpoint (invalid_grant is a 400).
 * Anything else — network failures, 429s, 5xx — is transient and must never
 * destroy stored credentials.
 */
export function isTokenRejection(err: unknown): boolean {
  return (
    err instanceof HubApiError && (err.status === 400 || err.status === 401 || err.status === 403)
  )
}
