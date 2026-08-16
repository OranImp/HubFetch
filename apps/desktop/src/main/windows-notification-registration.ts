/**
 * Portable Windows notification support.
 *
 * System toasts in Electron are routed by AppUserModelID. Installers (NSIS)
 * normally create the Start Menu shortcut whose AUMID matches
 * `app.setAppUserModelId(...)`; in no-installer ZIP mode nothing does, so
 * `Notification.show()` silently no-ops. This module creates/repairs the
 * current-user Start Menu shortcut (`...\Programs\HubFetch.lnk`) with the
 * HubFetch AUMID so toasts become functional again. It is best-effort: any
 * failure must never disable the in-app notification fallback.
 */
import { dirname, join } from 'node:path'
import type { ShortcutDetails } from 'electron'
import type { NotificationRegistrationInfo } from '@hubfetch/shared'

export type { NotificationRegistrationStatus } from '@hubfetch/shared'

/** Shortcut path for the current user's Start Menu Programs folder. */
export function startMenuShortcutPath(appData: string, appName: string): string {
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${appName}.lnk`)
}

export interface WindowsRegistrationDeps {
  isPackaged: boolean
  platform: NodeJS.Platform
  execPath: string
  /** `app.getPath('appData')` — the current user's %APPDATA%. */
  appData: string
  appName: string
  appUserModelId: string
  notificationsEnabled: boolean
  writeShortcutLink: (
    shortcutPath: string,
    operation: 'create' | 'update' | 'replace',
    options: ShortcutDetails
  ) => boolean
  readShortcutLink: (shortcutPath: string) => ShortcutDetails
}

/** Strip drive-letter and user-profile paths so diagnostics never leak them. */
export function sanitizeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/[A-Za-z]:\\[^\s"]+/g, '<path>')
    .replace(/\\Users\\[^\\\s]+/gi, '\\Users\\<user>')
    .slice(0, 500)
}

/**
 * Create or repair the HubFetch Start Menu shortcut with the AUMID. Returns a
 * typed status for diagnostics. Runs after app ready; call it before the
 * NotificationService is constructed so a successful registration is reflected
 * in every notification emitted this session.
 */
export function registerWindowsNotificationShortcut(
  deps: WindowsRegistrationDeps
): NotificationRegistrationInfo {
  if (deps.platform !== 'win32') {
    return { status: 'unsupported', reason: 'platform is not Windows' }
  }
  if (!deps.isPackaged) {
    return { status: 'unsupported', reason: 'development build' }
  }
  if (!deps.notificationsEnabled) {
    return { status: 'disabled', reason: 'notifications disabled in settings' }
  }

  const shortcutPath = startMenuShortcutPath(deps.appData, deps.appName)
  const options: ShortcutDetails = {
    target: deps.execPath,
    cwd: dirname(deps.execPath),
    description: `${deps.appName} — unofficial desktop client for the Hugging Face Hub`,
    icon: deps.execPath,
    iconIndex: 0,
    appUserModelId: deps.appUserModelId
  }

  // 'replace' repairs a stale target (portable folder moved); 'update' refreshes
  // metadata on a matching shortcut; 'create' writes the first-time shortcut.
  let operation: 'create' | 'update' | 'replace'
  try {
    const existing = deps.readShortcutLink(shortcutPath)
    operation = existing.target === deps.execPath ? 'update' : 'replace'
  } catch {
    operation = 'create'
  }

  try {
    const ok = deps.writeShortcutLink(shortcutPath, operation, options)
    if (!ok) return { status: 'failed', reason: 'writeShortcutLink returned false' }
    return { status: 'registered' }
  } catch (error) {
    return { status: 'failed', reason: sanitizeReason(error) }
  }
}

export interface WindowsRemovalDeps {
  isPackaged: boolean
  platform: NodeJS.Platform
  appData: string
  appName: string
  existsSync: (path: string) => boolean
  unlinkSync: (path: string) => void
}

/**
 * Remove the Start Menu shortcut. Must be called ONLY during explicit app-data
 * cleanup — never during ordinary exit. Best-effort and never throws.
 */
export function removeWindowsNotificationShortcut(deps: WindowsRemovalDeps): boolean {
  if (deps.platform !== 'win32' || !deps.isPackaged) return false
  const shortcutPath = startMenuShortcutPath(deps.appData, deps.appName)
  try {
    if (deps.existsSync(shortcutPath)) {
      deps.unlinkSync(shortcutPath)
      return true
    }
  } catch {
    // Best-effort cleanup must never break the surrounding operation.
  }
  return false
}
