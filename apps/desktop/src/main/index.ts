import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  BrowserWindow,
  app,
  dialog,
  nativeTheme,
  protocol,
  session,
  shell,
  type WebContents
} from 'electron'
import { HubApiError } from '@hubfetch/hub-api'
import type { IpcEventChannel, IpcEventPayload, ProxyConfig } from '@hubfetch/shared'
import { isValidRepoId } from '@hubfetch/shared'
import {
  checkSenderTrust,
  decideExternalTarget,
  logBoundary,
  permissionCheckAllowed,
  resolveTrustedOrigins,
  type SenderSnapshot,
  type TrustedOrigins
} from './ipc-guard'
import { AuthManager } from './auth'
import { mimeForOmhfFile } from './preview-mime'
import { CacheManager } from './cache'
import { openDatabase } from './db'
import { DownloadManager } from './downloads'
import { FollowsPoller } from './follows'
import { createHubClient, createHubProxy, rebuildHubClient, type HubHolder } from './hub'
import { MainI18n, matchLocale } from './i18n'
import { IntegrationTaskManager } from './integration-tasks'
import { registerIpcHandlers } from './ipc'
import { Library } from './library'
import { buildMenu } from './menu'
import { NotificationService } from './notifications'
import { applyAppProxy } from './proxy'
import { APP_NAME, APP_USER_MODEL_ID, applyUserDataOverride } from './runtime-paths'
import { SettingsStore } from './settings'
import { TrayManager } from './tray'
import {
  registerWindowsNotificationShortcut,
  removeWindowsNotificationShortcut
} from './windows-notification-registration'

/** Concrete HTTP(S) proxy URL for a config; null for system/direct. */
function proxyUrlFromConfig(config: ProxyConfig): string | null {
  return config.mode === 'manual' ? config.manualUrl : null
}

// One HubFetch identity everywhere: the name drives the default userData root
// (`%APPDATA%\HubFetch`), so dev and packaged builds share one database and one
// safeStorage-encrypted credentials file. Nothing under the legacy Oh My
// HuggingFace name is read, written, or migrated. Keep this name stable — the
// runtime state lives and dies with it.
app.setName(APP_NAME)

// Windows routes toasts by AppUserModelID; it must match the shortcut AUMID
// electron-builder (NSIS) derives from appId in electron-builder.yml, or
// Notification.show() silently no-ops.
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)

// Repo images (file previews, README images) load through this custom scheme
// so the hub client's auth + proxy apply — a renderer <img> pointing straight
// at https://huggingface.co/…/resolve/… carries no Authorization header and
// 401s on private/gated repos. bypassCSP lets hubfetch: subresources load
// under the renderer CSP (img-src 'self' https: data:) without widening it
// for every scheme; the handler only ever proxies Hub resolve URLs. Must run
// before app ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'hubfetch',
    privileges: { standard: true, secure: true, stream: true, bypassCSP: true }
  }
])

const isDev = !app.isPackaged

// The only WebContents allowed through every privileged boundary. Trust is
// never inferred from scheme: the sender must be the app's own top-level
// frame at exactly the packaged `file:` entry (or the dev-server origin).
const trustedOrigins: TrustedOrigins = resolveTrustedOrigins(
  app.isPackaged,
  join(__dirname, '../renderer/index.html')
)

function isTrustedWebContents(wc: WebContents | null | undefined): boolean {
  if (!wc || wc.isDestroyed()) return false
  const sender: SenderSnapshot = { webContentsId: wc.id, isMainFrame: true, url: wc.getURL() }
  return checkSenderTrust(trustedOrigins, sender).ok
}

// The app never uses <webview>; any attachment attempt — from a compromised
// renderer or a regression — is refused before a single guest page exists.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
})

// Renderer crash / load-failure recovery: reload this many times before asking
// the user, with a short pause so a persistent crash can't spin a tight loop.
const MAX_RENDER_RECOVERIES = 3
const RENDER_RECOVERY_DELAY_MS = 1000

// E2E tests point userData at a temp dir so they never touch a real profile.
// Runs before any app.getPath('userData') read so the DB, credentials, cache,
// and settings all land under the override. The legacy user-data override
// variable is deliberately NOT honored.
applyUserDataOverride()

function broadcast<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void {
  // Callers include timers (download progress, inference delta flushes); a send that
  // races window destruction must never become an uncaught exception in main.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {
      /* window closed mid-send */
    }
  }
}

// Assigned inside app.whenReady() where the window factory lives; lets
// navigate() recreate the window when none exists (macOS keeps the app alive
// after the last window closes).
let recreateWindow: (() => BrowserWindow) | null = null
// Route queued while no window existed; createWindow flushes it once the new
// renderer has mounted and is actually listening for 'evt:navigate'.
let pendingRoute: string | null = null

function navigate(route: string): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    // Broadcasting now would be dropped — no renderer is listening yet.
    pendingRoute = route
    recreateWindow?.()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  broadcast('evt:navigate', route)
}

// Dev and packaged now share one app identity; skip the lock in dev so a running
// packaged instance doesn't swallow `pnpm dev` launches.
const gotLock = app.isPackaged ? app.requestSingleInstanceLock() : true
if (!gotLock) {
  app.quit()
} else {
  let isQuitting = false

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  void app.whenReady().then(async () => {
    const db = openDatabase()
    const settings = new SettingsStore(db)
    const i18n = new MainI18n()
    const configuredLocale = settings.get().locale
    i18n.setLocale(configuredLocale === 'system' ? matchLocale(app.getLocale()) : configuredLocale)

    const auth = new AuthManager(db, (state) => broadcast('evt:auth', state))
    const initial = settings.get()
    const hubHolder: HubHolder = {
      current: createHubClient(
        () => auth.accessToken(),
        () => auth.sessionCookie(),
        {
          endpoint: initial.hubEndpoint,
          proxyUrl: proxyUrlFromConfig(initial.proxy)
        }
      )
    }
    const hub = createHubProxy(hubHolder)
    auth.attachClient(hubHolder.current)
    await applyAppProxy(initial.proxy)
    app.setLoginItemSettings({ openAtLogin: initial.launchAtLogin })

    // Permission policy — default deny. No renderer permission request is ever
    // granted (Spaces embedded as sandboxed iframes cannot reach the camera,
    // microphone, fullscreen, geolocation, notifications, or display capture),
    // and only clipboard writes from the app's own frame stay usable so the
    // error-detail / raw-URL copy buttons keep working.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false)
    })
    session.defaultSession.setPermissionCheckHandler((wc, permission) => {
      return permissionCheckAllowed(isTrustedWebContents(wc), permission)
    })

    // hubfetch://repo/?kind=…&repoId=…&revision=…&path=… → authenticated
    // fetch of the Hub resolve URL through the live hub client (token + proxy
    // + endpoint rebuilds all apply; the token never reaches the renderer).
    // The upstream response streams through; failures map to plain status
    // responses so a broken image stays a broken image.
    protocol.handle('hubfetch', async (request) => {
      const params = new URL(request.url).searchParams
      const kindParam = params.get('kind')
      const kind =
        kindParam === 'model' || kindParam === 'dataset' || kindParam === 'space' ? kindParam : null
      const repoId = params.get('repoId')
      const path = params.get('path')
      const revision = params.get('revision') ?? 'main'
      if (!kind || !repoId || !path) {
        return new Response('invalid hubfetch URL', { status: 400 })
      }
      // The token rides this request, so refuse anything that could redirect it
      // off the addressed repo: a malformed repoId (unencoded in the resolve
      // URL), or a path with traversal/empty segments that URL normalization
      // would resolve outside the repo. The revision is encodeURIComponent'd by
      // resolveUrl, so its separators can't traverse and it needs no guard.
      const segments = path.split('/')
      if (!isValidRepoId(repoId) || segments.some((s) => s === '..' || s === '.' || s === '')) {
        return new Response('invalid hubfetch URL', { status: 400 })
      }
      try {
        const upstream = await hub.fetchFileResponse(kind, repoId, path, revision)
        // Rebuild as a plain Response with Content-Type only: undici
        // decompresses bodies, so the upstream Content-Length may not match
        // what actually streams out.
        const headers = new Headers()
        const mime = mimeForOmhfFile(path, upstream.headers.get('Content-Type'))
        if (mime) headers.set('Content-Type', mime)
        return new Response(upstream.body, { status: upstream.status, headers })
      } catch (err) {
        const status = err instanceof HubApiError && err.status ? err.status : 502
        return new Response(err instanceof Error ? err.message : 'fetch failed', { status })
      }
    })

    const library = new Library(db, () => settings.get().historyLimit)
    // Portable ZIP builds have no installer to place the Start Menu shortcut, so
    // Windows toast AUMID routing would silently no-op. Register/repair the
    // shortcut now — before any NotificationService emission — and surface the
    // typed outcome to diagnostics. Any failure keeps the in-app fallback.
    const notificationRegistration = registerWindowsNotificationShortcut({
      isPackaged: app.isPackaged,
      platform: process.platform,
      execPath: process.execPath,
      appData: app.getPath('appData'),
      appName: APP_NAME,
      appUserModelId: APP_USER_MODEL_ID,
      notificationsEnabled: settings.get().notificationsEnabled,
      writeShortcutLink: shell.writeShortcutLink,
      readShortcutLink: shell.readShortcutLink
    })
    const notifications = new NotificationService(settings, i18n, navigate)
    const downloads = new DownloadManager(
      db,
      settings,
      hub,
      notifications,
      () => auth.accessToken(),
      (tasks) => broadcast('evt:downloads', tasks)
    )
    // Cache cleanup must spare partials of still-resumable downloads.
    const cache = new CacheManager(
      settings,
      () => downloads.protectedTaskIds(),
      (kind, repoId) => downloads.protectedCommits(kind, repoId)
    )
    const integrationTasks = new IntegrationTaskManager({
      accessToken: () => auth.accessToken(),
      username: () => {
        const state = auth.getState()
        return state.status === 'signedIn' ? state.user.name : undefined
      },
      cacheDir: () => cache.cacheDir(),
      broadcast: (tasks) => broadcast('evt:integrationTasks', tasks),
      notifications
    })
    const follows = new FollowsPoller(
      library,
      hub,
      settings,
      (items) => broadcast('evt:inbox', items),
      notifications
    )

    const tray = new TrayManager(
      () => BrowserWindow.getAllWindows()[0],
      i18n,
      () => {
        isQuitting = true
        app.quit()
      }
    )

    const rebuildMenu = (): void => {
      buildMenu(i18n, navigate)
      tray.refreshMenu()
    }

    const applyNetworkSettings = async (
      next: { hubEndpoint: string | null; proxy: ProxyConfig },
      prev: { hubEndpoint: string | null; proxy: ProxyConfig }
    ): Promise<void> => {
      const endpointChanged = next.hubEndpoint !== prev.hubEndpoint
      const proxyChanged =
        next.proxy.mode !== prev.proxy.mode || next.proxy.manualUrl !== prev.proxy.manualUrl
      if (!endpointChanged && !proxyChanged) return
      if (proxyChanged) await applyAppProxy(next.proxy)
      // A web-session cookie is bound to the host it was captured on; it must
      // never ride along to a different (mirror) endpoint.
      if (endpointChanged) await auth.disconnectHubSession()
      if (endpointChanged || proxyChanged) {
        rebuildHubClient(
          hubHolder,
          () => auth.accessToken(),
          () => auth.sessionCookie(),
          {
            endpoint: next.hubEndpoint,
            proxyUrl: proxyUrlFromConfig(next.proxy)
          }
        )
        auth.attachClient(hubHolder.current)
      }
    }

    const isDarkTheme = (): boolean => {
      const theme = settings.get().theme
      return theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
    }

    // Native minimize/maximize/close drawn over the TopBar (h-11 = 44px);
    // colors track the renderer theme (--c-bg / --c-ink-muted). Height is
    // 43px — one short of the TopBar — so the overlay's opaque background
    // doesn't paint over the header's 1px bottom border.
    const titleBarOverlay = (): Electron.TitleBarOverlayOptions =>
      isDarkTheme()
        ? { color: '#030712', symbolColor: '#99a1af', height: 43 }
        : { color: '#ffffff', symbolColor: '#4a5565', height: 43 }

    const refreshTitleBarOverlay = (): void => {
      if (process.platform !== 'win32') return
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.setTitleBarOverlay(titleBarOverlay())
      }
    }
    nativeTheme.on('updated', refreshTitleBarOverlay)

    const applyDesktopSettings = (
      next: { launchAtLogin: boolean; closeToTray: boolean; theme: string },
      prev: { launchAtLogin: boolean; closeToTray: boolean; theme: string }
    ): void => {
      if (next.theme !== prev.theme) refreshTitleBarOverlay()
      if (next.launchAtLogin !== prev.launchAtLogin) {
        app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
      }
      if (next.closeToTray === prev.closeToTray) return
      if (next.closeToTray) {
        tray.ensure()
      } else {
        const win = BrowserWindow.getAllWindows()[0]
        if (win && !win.isDestroyed() && !win.isVisible()) {
          win.show()
        }
        tray.destroy()
      }
    }

    registerIpcHandlers(
      {
        db,
        hub,
        auth,
        settings,
        library,
        downloads,
        cache,
        follows,
        integrationTasks,
        i18n,
        rebuildMenu,
        notificationRegistration,
        removeNotificationShortcut: () =>
          removeWindowsNotificationShortcut({
            isPackaged: app.isPackaged,
            platform: process.platform,
            appData: app.getPath('appData'),
            appName: APP_NAME,
            existsSync,
            unlinkSync
          }),
        broadcast,
        applyNetworkSettings,
        applyDesktopSettings
      },
      trustedOrigins
    )
    rebuildMenu()
    if (initial.closeToTray) tray.ensure()

    const windowBackground = (): string => (isDarkTheme() ? '#030712' : '#ffffff')

    const createWindow = (backgroundColor: string): BrowserWindow => {
      const win = new BrowserWindow({
        width: 1360,
        height: 860,
        minWidth: 760,
        minHeight: 520,
        show: false,
        // Matches the renderer's --c-bg per theme so first paint never flashes white.
        backgroundColor,
        // Hide the native menu bar on Windows/Linux (Alt reveals it); its
        // accelerators (Ctrl+1..8, Ctrl+,, zoom, reload) keep working.
        autoHideMenuBar: true,
        ...(process.platform === 'darwin'
          ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 14 } }
          : {}),
        // Windows: drop the native title bar; the system window controls render
        // as an overlay on the TopBar (keeps Snap Layouts on the maximize button).
        ...(process.platform === 'win32'
          ? { titleBarStyle: 'hidden' as const, titleBarOverlay: titleBarOverlay() }
          : {}),
        // Window/taskbar icon for Windows and Linux; macOS uses the app bundle icon.
        ...(process.platform !== 'darwin' ? { icon: join(__dirname, '../../build/icon.png') } : {}),
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true
        }
      })

      win.on('ready-to-show', () => win.show())

      win.on('close', (event) => {
        if (isQuitting || !settings.get().closeToTray) return
        event.preventDefault()
        win.hide()
        tray.ensure()
      })

      // Every external navigation goes through the system browser; the window
      // never leaves the app. Only allowlisted HTTPS destinations (plus the
      // configured Hub origin over plaintext HTTP) are handed to the OS; the
      // internal hubfetch: scheme is never opened externally.
      win.webContents.setWindowOpenHandler(({ url }) => {
        const action = decideExternalTarget(url, settings.get().hubEndpoint)
        logBoundary('window-open', url, action)
        if (action === 'open-external') void shell.openExternal(url)
        return { action: 'deny' }
      })
      win.webContents.on('will-navigate', (event, url) => {
        if (url === win.webContents.getURL()) return
        event.preventDefault()
        const action = decideExternalTarget(url, settings.get().hubEndpoint)
        logBoundary('will-navigate', url, action)
        if (action === 'open-external') void shell.openExternal(url)
      })

      // A route queued while no window existed cannot be sent at did-finish-load:
      // the renderer bootstraps asynchronously (awaits settings/auth IPC in
      // main.tsx) before mounting React, so the 'evt:navigate' listener attaches
      // well after the load event. Wait for the React tree to commit into #root,
      // then flush.
      win.webContents.on('did-finish-load', () => {
        if (pendingRoute === null) return
        void win.webContents
          .executeJavaScript(
            `new Promise((resolve) => {
              const root = document.getElementById('root')
              if (!root || root.childElementCount > 0) return resolve(undefined)
              new MutationObserver((_records, observer) => {
                if (root.childElementCount > 0) {
                  observer.disconnect()
                  resolve(undefined)
                }
              }).observe(root, { childList: true })
            })`
          )
          .then(() => {
            const route = pendingRoute
            if (route === null) return
            pendingRoute = null
            broadcast('evt:navigate', route)
          })
          .catch(() => {
            /* window destroyed before the renderer mounted */
          })
      })

      // Recover from renderer crashes and failed loads instead of leaving a
      // permanently blank window; past the retry bound the user decides.
      let renderFailures = 0
      const recoverRenderer = (reason: string): void => {
        if (win.isDestroyed() || isQuitting) return
        renderFailures += 1
        console.error(
          `[window] renderer failure (${reason}), recovery ${renderFailures}/${MAX_RENDER_RECOVERIES}`
        )
        if (renderFailures <= MAX_RENDER_RECOVERIES) {
          setTimeout(() => {
            if (!win.isDestroyed()) win.webContents.reload()
          }, RENDER_RECOVERY_DELAY_MS)
          return
        }
        void dialog
          .showMessageBox(win, {
            type: 'error',
            title: i18n.t('app.name'),
            message: i18n.t('dialogs.renderFailureMessage'),
            detail: i18n.t('dialogs.renderFailureDetail'),
            buttons: [i18n.t('dialogs.renderFailureReload'), i18n.t('dialogs.renderFailureQuit')],
            defaultId: 0
          })
          .then(({ response }) => {
            if (response === 0) {
              renderFailures = 0
              if (!win.isDestroyed()) win.webContents.reload()
            } else {
              app.quit()
            }
          })
      }
      win.webContents.on('render-process-gone', (_event, details) => {
        // 'clean-exit' accompanies ordinary teardown (window close, app quit).
        if (details.reason === 'clean-exit') return
        recoverRenderer(details.reason)
      })
      win.webContents.on(
        'did-fail-load',
        (_event, errorCode, errorDescription, _url, isMainFrame) => {
          // -3 (ERR_ABORTED) is a cancelled navigation, not a failure.
          if (!isMainFrame || errorCode === -3) return
          recoverRenderer(`${errorCode} ${errorDescription}`)
        }
      )

      if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void win.loadURL(process.env.ELECTRON_RENDERER_URL)
      } else {
        void win.loadFile(join(__dirname, '../renderer/index.html'))
      }
      return win
    }

    // Single window-creation path shared by startup, dock activate, and
    // navigate() (menu accelerators / notification clicks with no window).
    const createAppWindow = (): BrowserWindow => createWindow(windowBackground())
    recreateWindow = createAppWindow

    createAppWindow()
    follows.start()

    // Session restore happens after the window exists so auth events reach the UI.
    void auth.init()

    app.on('activate', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      } else {
        createAppWindow()
      }
    })

    app.on('before-quit', () => {
      isQuitting = true
      downloads.shutdown()
      integrationTasks.shutdown()
      follows.stop()
      tray.destroy()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
