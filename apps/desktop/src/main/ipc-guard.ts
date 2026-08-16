/**
 * Electron privilege-boundary policy (plan Todo 18).
 *
 * A WebContents may exercise privileged capabilities — IPC invoke, external
 * navigation, permission grants, webview attachment — only when it is the
 * app's own top-level frame at exactly the trusted renderer URL: the resolved
 * packaged `file:` entry, or the configured dev-server origin. Scheme alone is
 * never trusted and subframes are never trusted. All functions here are pure
 * and Electron-free so the rejection matrix is unit-testable; the main-process
 * wiring (ipc.ts / index.ts) is the only place that reads Electron objects.
 */
import { pathToFileURL } from 'node:url'
import { isAllowedExternalUrl } from '@hubfetch/shared'

export interface TrustedOrigins {
  /** Canonical `file:` URL of the packaged renderer entry — always trusted. */
  packagedEntry: string
  /** Dev-server origin (`http://localhost:<port>`) when running via `electron-vite dev`. */
  devOrigin: string | null
}

/**
 * Resolve the trusted renderer origins once at startup. The packaged entry is
 * always trusted (it is the exact path `win.loadFile` loads); the dev origin
 * only exists under `electron-vite dev` and is read from its environment.
 */
export function resolveTrustedOrigins(
  isPackaged: boolean,
  packagedRendererEntry: string
): TrustedOrigins {
  return {
    packagedEntry: pathToFileURL(packagedRendererEntry).href,
    devOrigin: isPackaged ? null : (process.env.ELECTRON_RENDERER_URL ?? null)
  }
}

/** Minimal snapshot of a WebContents identity, taken by the Electron wiring. */
export interface SenderSnapshot {
  webContentsId: number
  isMainFrame: boolean
  url: string
}

export type SenderTrust =
  { ok: true } | { ok: false; reason: 'no-web-contents' | 'no-main-frame' | 'untrusted-url' }

/**
 * Trust check for an IPC invoke / permission request / navigation decision.
 * Rejects when the sender has no usable WebContents id, when the frame is not
 * the main frame, or when the URL is not one of the exact trusted origins.
 * file: URLs are compared case-insensitively (Windows drive letters).
 */
export function checkSenderTrust(origins: TrustedOrigins, sender: SenderSnapshot): SenderTrust {
  if (!Number.isInteger(sender.webContentsId) || sender.webContentsId <= 0) {
    return { ok: false, reason: 'no-web-contents' }
  }
  if (sender.isMainFrame !== true) {
    return { ok: false, reason: 'no-main-frame' }
  }
  const url = normalizeTrustedUrl(stripFragment(sender.url))
  if (url === normalizeTrustedUrl(origins.packagedEntry)) return { ok: true }
  if (origins.devOrigin) {
    const devBase = normalizeTrustedUrl(stripFragment(origins.devOrigin)).replace(/\/+$/, '')
    if (url === devBase || url.startsWith(`${devBase}/`)) return { ok: true }
  }
  return { ok: false, reason: 'untrusted-url' }
}

/**
 * The renderer uses hash routing (`file://…/index.html#/history`), so the
 * sender URL carries a client-side fragment that is never sent anywhere. The
 * fragment is stripped before comparing against the trusted entry URL.
 */
function stripFragment(value: string): string {
  const hashIndex = value.indexOf('#')
  return hashIndex < 0 ? value : value.slice(0, hashIndex)
}

function normalizeTrustedUrl(value: string): string {
  return value.startsWith('file:') ? value.toLowerCase() : value
}

export type ExternalAction = 'open-external' | 'deny'

/**
 * External-navigation policy for `setWindowOpenHandler` / `will-navigate`.
 * Only allowlisted HTTPS destinations (the shared `isAllowedExternalUrl`
 * policy) are handed to the OS browser; the `hubfetch:` custom scheme is
 * internal and never opens externally; everything else is denied.
 */
export function decideExternalTarget(url: string, hubEndpoint?: string | null): ExternalAction {
  if (url.startsWith('hubfetch:')) return 'deny'
  return isAllowedExternalUrl(url, hubEndpoint) ? 'open-external' : 'deny'
}

/**
 * Permission policy for `session.setPermissionCheckHandler`. Only clipboard
 * writes from the app's own trusted frame are usable (error-detail copy
 * buttons); every other permission — media, geolocation, notifications,
 * fullscreen — is denied. Untrusted frames get nothing.
 */
export function permissionCheckAllowed(trustedFrame: boolean, permission: string): boolean {
  if (!trustedFrame) return false
  return permission === 'clipboard-sanitized-write' || permission === 'clipboard-write'
}

/** Host-level metadata only (protocol + hostname), never path/query/fragment. */
export function sanitizedHost(url: string): string {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname) return '<invalid-url>'
    return `${parsed.protocol}//${parsed.hostname}`
  } catch {
    return '<invalid-url>'
  }
}

/** Sanitized boundary log: decision + host only, no query strings or payloads. */
export function logBoundary(kind: string, url: string, action: string): void {
  console.warn(`[boundary] ${kind} ${action} target=${sanitizedHost(url)}`)
}

/** Sanitized IPC denial log: channel + sender id + reason, never the payload. */
export function logIpcDenial(channel: string, webContentsId: number, reason: string): void {
  console.warn(`[ipc-guard] denied invoke ${channel} sender=${webContentsId} reason=${reason}`)
}
