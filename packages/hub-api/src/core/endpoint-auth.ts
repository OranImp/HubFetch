import { normalizeHubEndpoint } from '@hubfetch/shared'

export type AuthMode = 'token' | 'cookie'

export interface AuthHeaderOptions {
  readonly referer?: string
  readonly extraCookies?: readonly string[]
}

/** Normalized endpoint and the host policy used by every credentialed request. */
export class HubEndpointPolicy {
  readonly endpoint: string
  private readonly endpointHost: string

  constructor(requestedEndpoint: string) {
    let endpoint = requestedEndpoint.replace(/\/$/, '')
    try {
      endpoint = normalizeHubEndpoint(requestedEndpoint)
    } catch {
      // Preserve the historical invalid-endpoint behavior used by the auth allow-list path.
    }
    this.endpoint = endpoint
    try {
      this.endpointHost = new URL(endpoint).hostname
    } catch {
      // Non-URL endpoints cannot authorize a request by configured host.
      this.endpointHost = ''
    }
  }

  /** Credentials may target the configured host or any Hugging Face host. */
  allowsAuth(url: string): boolean {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return false
    }
    return (
      (this.endpointHost !== '' && host === this.endpointHost) ||
      host === 'huggingface.co' ||
      host.endsWith('.huggingface.co')
    )
  }
}

/**
 * Build a Cookie request header from a stored Hub web session. Raw token values
 * and full cookie jars are both accepted; cookie names are not duplicated.
 */
export function formatSessionCookie(session: string, extras: string[] = []): string {
  const base = /\btoken=/i.test(session) ? session : `token=${session}`
  const seen = new Set(
    base
      .split(';')
      .map((part) => part.trim().split('=', 1)[0]?.toLowerCase())
      .filter((name): name is string => Boolean(name))
  )
  const extraParts: string[] = []
  for (const pair of extras) {
    const name = pair.split('=', 1)[0]?.trim().toLowerCase()
    if (!name || name === 'token' || seen.has(name)) continue
    seen.add(name)
    extraParts.push(pair)
  }
  return extraParts.length === 0 ? base : `${base}; ${extraParts.join('; ')}`
}
