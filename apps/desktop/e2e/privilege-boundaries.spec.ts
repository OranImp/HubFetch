import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

/**
 * Privilege-boundary probes (plan Todo 18 QA):
 *
 * Happy — the app's own main frame at the trusted file: URL can run one read
 *   and one write invoke, and an allowlisted external link is routed to the OS
 *   browser (popup window itself always denied).
 * Failure — a synthetic rogue WebContents, a subframe, `https://evil.example`
 *   navigation/window.open, and a permission request are all denied, with only
 *   sanitized metadata (channel/sender-id/hostname) reaching the log.
 *
 * Headless per boulder policy: the app's own window is created with
 * `show: false`, and every probe window is created hidden.
 */

const EVIL_PRELOAD = join(__dirname, 'fixtures', 'evil-preload.cjs')

async function launchApp(): Promise<ElectronApplication> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'hubfetch-e2e-'))
  return electron.launch({
    args: ['.'],
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      HUBFETCH_USER_DATA_DIR: userDataDir,
      HUBFETCH_CREDENTIALS_DIR: userDataDir
    }
  })
}

/** Route shell.openExternal to an in-memory list so no OS browser is opened. */
async function patchShell(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const patched = shell as typeof shell & { __openedUrls: string[] }
    patched.__openedUrls = []
    patched.openExternal = (url: string) => {
      patched.__openedUrls.push(url)
      return Promise.resolve()
    }
  })
}

async function readOpenedUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ shell }) => {
    const patched = shell as typeof shell & { __openedUrls: string[] }
    return patched.__openedUrls ?? []
  })
}

test('trusted main frame runs read/write invokes and routes an approved external link to the OS', async () => {
  const app = await launchApp()
  try {
    const window = await app.firstWindow()
    await window.waitForSelector('aside nav', { timeout: 30_000 })
    await patchShell(app)

    // READ invoke from the trusted main frame.
    const appInfo = await window.evaluate(() =>
      window.hubfetch.invoke('system:getAppInfo', undefined)
    )
    expect(appInfo).toMatchObject({ version: '0.2.0' })

    // WRITE invoke from the trusted main frame.
    await window.evaluate(() =>
      window.hubfetch.invoke('settings:set', { patch: { theme: 'dark' } })
    )
    const settings = await window.evaluate(() => window.hubfetch.invoke('settings:get', undefined))
    expect(settings.theme).toBe('dark')

    // Approved external link via the typed IPC bridge.
    await window.evaluate(() =>
      window.hubfetch.invoke('system:openExternal', { url: 'https://github.com' })
    )
    // Approved external link via window.open: the popup window is denied
    // (returns null) but the URL is handed to the OS browser.
    const popupDenied = await window.evaluate(
      () => window.open('https://github.com', '_blank') === null
    )
    expect(popupDenied).toBe(true)

    const opened = await readOpenedUrls(app)
    // Chromium normalizes the window.open URL to https://github.com/; the IPC
    // path passes the literal string. Both must have reached the OS browser.
    expect(opened.filter((url) => url.startsWith('https://github.com')).length).toBe(2)
  } finally {
    await app.close()
  }
})

test('rogue web contents, subframe, evil navigation, and permission requests are denied with sanitized logs', async () => {
  const app = await launchApp()
  const consoleLines: string[] = []
  app.on('console', (message) => consoleLines.push(message.text()))
  try {
    const window = await app.firstWindow()
    await window.waitForSelector('aside nav', { timeout: 30_000 })
    await patchShell(app)

    // (a) A rogue WebContents invoking a privileged channel is rejected before
    //     the service call runs — even though the payload is valid.
    const rogue = await app.evaluate(async ({ BrowserWindow }, evilPreload: string) => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: evilPreload,
          contextIsolation: true,
          sandbox: false,
          nodeIntegration: false
        }
      })
      try {
        await win.loadURL('data:text/html,<html><body>rogue</body></html>')
        const result = await win.webContents.executeJavaScript(
          `window.evil.tryInvoke('system:getAppInfo')
               .then(() => ({ ok: true }))
               .catch((err) => ({ ok: false, message: String(err?.message ?? err) }))`
        )
        return result
      } finally {
        if (!win.isDestroyed()) win.destroy()
      }
    }, EVIL_PRELOAD)
    expect(rogue).toEqual({ ok: false, message: expect.stringContaining('IPC sender rejected') })

    // (b) A subframe (same-origin, same preload) is denied. The probe page and
    //     its iframe are served from a local HTTP server; the iframe's inline
    //     script invokes IPC through the preload bridge and reports the outcome
    //     back to the (same-origin) parent frame.
    const frameServer = createServer((req, res) => {
      if (req.url === '/child') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          '<!doctype html><html><body>child</body>' +
            '<script>' +
            "window.evil.tryInvoke('system:getAppInfo')" +
            '.then(() => { window.parent.__subframeResult = { ok: true } })' +
            '.catch((err) => { window.parent.__subframeResult = { ok: false, message: String(err?.message ?? err) } })' +
            '</script></html>'
        )
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!doctype html><html><body><iframe src="/child"></iframe></body></html>')
    })
    await new Promise<void>((resolve) => frameServer.listen(0, '127.0.0.1', resolve))
    const framePort = (frameServer.address() as AddressInfo).port
    const subframe = await app.evaluate(
      async (
        { BrowserWindow },
        { parentUrl, evilPreload }: { parentUrl: string; evilPreload: string }
      ) => {
        const win = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: evilPreload,
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: true
          }
        })
        try {
          await win.loadURL(parentUrl)
          const result = await win.webContents.executeJavaScript(
            `new Promise((resolve) => {
               const started = Date.now()
               const poll = () => {
                 const out = window.__subframeResult
                 if (out) return resolve(out)
                 if (Date.now() - started > 5000) return resolve({ ok: false, message: 'subframe-timeout' })
                 setTimeout(poll, 50)
               }
               poll()
             })`
          )
          return result
        } finally {
          if (!win.isDestroyed()) win.destroy()
        }
      },
      { parentUrl: `http://127.0.0.1:${framePort}/`, evilPreload: EVIL_PRELOAD }
    )
    await new Promise<void>((resolve) => frameServer.close(() => resolve()))
    expect(subframe.ok).toBe(false)
    expect(subframe.message).toMatch(/IPC sender rejected|no-bridge-in-subframe/)

    // (c) https://evil.example navigation is denied — the window stays put.
    //     HTTPS is an allowlisted external scheme, so the URL is handed to the
    //     OS browser while the app window never navigates; a plaintext
    //     http://evil.example is fully denied.
    const before = await window.evaluate(() => window.location.href)
    await window.evaluate(() => {
      window.location.href = 'https://evil.example/'
    })
    await window.waitForTimeout(600)
    const after = await window.evaluate(() => window.location.href)
    expect(after).toBe(before)
    await window.evaluate(() => {
      window.location.href = 'http://evil.example/'
    })
    await window.waitForTimeout(600)
    expect(await window.evaluate(() => window.location.href)).toBe(before)

    // (d) window.open popups are always denied; a disallowed plaintext URL is
    //     never handed to the OS browser.
    const evilPopupDenied = await window.evaluate(
      () => window.open('https://evil.example/', '_blank') === null
    )
    expect(evilPopupDenied).toBe(true)
    const httpDenied = await window.evaluate(
      () => window.open('http://evil.example/', '_blank') === null
    )
    expect(httpDenied).toBe(true)
    const opened = await readOpenedUrls(app)
    expect(opened).not.toContain('http://evil.example/')

    // (e) Permission requests/checks default to denied.
    const cameraState = await window.evaluate(async () => {
      const status = await navigator.permissions.query({ name: 'camera' as PermissionName })
      return status.state
    })
    expect(cameraState).toBe('denied')

    // Sanitized metadata only: boundary/guard lines carry channel or hostname,
    // never a payload or a query string.
    expect(consoleLines.some((line) => line.includes('[ipc-guard] denied invoke'))).toBe(true)
    expect(
      consoleLines.some((line) =>
        line.includes('[boundary] will-navigate open-external target=https://evil.example')
      )
    ).toBe(true)
    expect(
      consoleLines.some((line) =>
        line.includes('[boundary] will-navigate deny target=http://evil.example')
      )
    ).toBe(true)
  } finally {
    await app.close()
  }
})
