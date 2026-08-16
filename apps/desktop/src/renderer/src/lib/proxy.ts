/**
 * Pure proxy-selection helpers for the renderer. Validation is NEVER duplicated
 * here: the Manual URL rule is the shared `normalizeManualProxyUrl` from
 * @hubfetch/shared — the same rule the IPC schemas enforce in main. These
 * helpers only compose drafts into closed values, so the components stay thin
 * and the behaviour is unit-testable in the node-env suite.
 */
import {
  DEFAULT_MANUAL_PROXY_URL,
  normalizeManualProxyUrl,
  type DownloadProxyOverride,
  type ProxyConfig,
  type ProxyMode,
  type ProxySnapshot
} from '@hubfetch/shared'

/** Result of parsing the Manual URL draft with the SHARED validator only. */
export type ManualProxyDraftResult = { ok: true; value: string | null } | { ok: false }

/**
 * Parse the Manual URL draft. Empty is a valid "no URL yet" (null); anything
 * else must normalize to a closed http(s) host:port URL. Credential-bearing,
 * malformed, and path/query/fragment forms are rejected exactly as the IPC
 * schema rejects them.
 */
export function parseManualProxyDraft(raw: string): ManualProxyDraftResult {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  const normalized = normalizeManualProxyUrl(trimmed)
  return normalized === null ? { ok: false } : { ok: true, value: normalized }
}

/**
 * Build a closed settings ProxyConfig from the mode + Manual URL drafts.
 * Manual mode requires a valid concrete URL (else the apply is rejected before
 * any IPC call). Non-Manual modes retain the last valid Manual URL — the edited
 * draft when it validates, otherwise the previously persisted value, otherwise
 * the DEFAULT_MANUAL_PROXY_URL seed — so Manual always remembers its value.
 */
export function proxyConfigFromDraft(
  mode: ProxyMode,
  manualDraft: string,
  previous: ProxyConfig
): { ok: true; config: ProxyConfig } | { ok: false } {
  const parsed = parseManualProxyDraft(manualDraft)
  if (mode === 'manual') {
    if (!parsed.ok || parsed.value === null) return { ok: false }
    return { ok: true, config: { mode: 'manual', manualUrl: parsed.value } }
  }
  const retained = parsed.ok && parsed.value !== null ? parsed.value : previous.manualUrl
  return { ok: true, config: { mode, manualUrl: retained ?? DEFAULT_MANUAL_PROXY_URL } }
}

/** Download-create selection state (before confirmation). */
export interface DownloadProxySelection {
  /** Follow the persisted settings ProxyConfig at create time. */
  useDefault: boolean
  mode: ProxyMode
  /** Manual URL draft (empty = nothing typed yet). */
  manualUrl: string
}

/**
 * Resolve the `downloads:start` request `proxy` field from the create-dialog
 * selection — called ONLY when the user confirms. `useDefault` resolves to
 * `null` (no override: the manager freezes the settings config). Explicit
 * modes resolve to a closed DownloadProxyOverride; an invalid Manual draft
 * resolves to `null` too, which the caller treats as "confirm disabled" rather
 * than ever sending a bad value to IPC.
 */
export function resolveCreateProxy(
  selection: DownloadProxySelection
): DownloadProxyOverride | null {
  if (selection.useDefault) return null
  switch (selection.mode) {
    case 'system':
      return { mode: 'system' }
    case 'direct':
      return { mode: 'direct' }
    case 'manual': {
      const parsed = parseManualProxyDraft(selection.manualUrl)
      return parsed.ok && parsed.value !== null ? { mode: 'manual', url: parsed.value } : null
    }
  }
}

/** Frozen task snapshot → display parts for the task-detail badge. */
export function snapshotDisplay(snapshot: ProxySnapshot): {
  mode: ProxyMode
  url: string | null
} {
  switch (snapshot.mode) {
    case 'system':
      return { mode: 'system', url: null }
    case 'direct':
      return { mode: 'direct', url: null }
    case 'manual':
      return { mode: 'manual', url: snapshot.url }
  }
}
