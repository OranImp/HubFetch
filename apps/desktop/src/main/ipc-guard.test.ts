import { describe, expect, it, vi } from 'vitest'
import {
  checkSenderTrust,
  decideExternalTarget,
  logBoundary,
  logIpcDenial,
  permissionCheckAllowed,
  resolveTrustedOrigins,
  sanitizedHost,
  type TrustedOrigins
} from './ipc-guard'

const PACKAGED_ENTRY = 'file:///E:/Apps/HubFetch/resources/app.asar/out/renderer/index.html'
const ORIGINS: TrustedOrigins = { packagedEntry: PACKAGED_ENTRY, devOrigin: null }

describe('checkSenderTrust', () => {
  it('accepts the app main frame at the exact packaged file entry', () => {
    expect(
      checkSenderTrust(ORIGINS, {
        webContentsId: 7,
        isMainFrame: true,
        url: PACKAGED_ENTRY
      })
    ).toEqual({ ok: true })
  })

  it('accepts the main frame under a configured dev origin', () => {
    const dev: TrustedOrigins = {
      packagedEntry: PACKAGED_ENTRY,
      devOrigin: 'http://localhost:5173'
    }
    expect(
      checkSenderTrust(dev, { webContentsId: 3, isMainFrame: true, url: 'http://localhost:5173/' })
    ).toEqual({ ok: true })
    expect(
      checkSenderTrust(dev, { webContentsId: 3, isMainFrame: true, url: 'http://localhost:5173' })
    ).toEqual({ ok: true })
  })

  it('rejects a sender with no usable WebContents id', () => {
    for (const id of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        checkSenderTrust(ORIGINS, { webContentsId: id, isMainFrame: true, url: PACKAGED_ENTRY })
      ).toEqual({ ok: false, reason: 'no-web-contents' })
    }
  })

  it('rejects any subframe, even at the trusted URL', () => {
    expect(
      checkSenderTrust(ORIGINS, { webContentsId: 7, isMainFrame: false, url: PACKAGED_ENTRY })
    ).toEqual({ ok: false, reason: 'no-main-frame' })
  })

  it('rejects untrusted URLs from a main frame', () => {
    const hostile = [
      'https://evil.example/',
      'http://evil.example/',
      'file:///C:/Windows/system.ini',
      'file:///E:/Apps/HubFetch/resources/app.asar/out/renderer/other.html',
      'data:text/html,<h1>rogue</h1>',
      'about:blank',
      '',
      'javascript:alert(1)'
    ]
    for (const url of hostile) {
      expect(checkSenderTrust(ORIGINS, { webContentsId: 7, isMainFrame: true, url })).toEqual({
        ok: false,
        reason: 'untrusted-url'
      })
    }
  })

  it('rejects a dev origin on the wrong port or host', () => {
    const dev: TrustedOrigins = {
      packagedEntry: PACKAGED_ENTRY,
      devOrigin: 'http://localhost:5173'
    }
    expect(
      checkSenderTrust(dev, { webContentsId: 3, isMainFrame: true, url: 'http://localhost:9999/' })
    ).toEqual({ ok: false, reason: 'untrusted-url' })
    expect(
      checkSenderTrust(dev, {
        webContentsId: 3,
        isMainFrame: true,
        url: 'http://evil.localhost:5173/'
      })
    ).toEqual({ ok: false, reason: 'untrusted-url' })
  })

  it('is case-insensitive for file: URLs (Windows drive letters)', () => {
    expect(
      checkSenderTrust(ORIGINS, {
        webContentsId: 7,
        isMainFrame: true,
        url: 'file:///e:/apps/hubfetch/resources/app.asar/out/renderer/index.html'
      })
    ).toEqual({ ok: true })
  })

  it('accepts the app frame after hash-route navigation (fragment stripped)', () => {
    expect(
      checkSenderTrust(ORIGINS, {
        webContentsId: 7,
        isMainFrame: true,
        url: `${PACKAGED_ENTRY}#/history`
      })
    ).toEqual({ ok: true })
    expect(
      checkSenderTrust(ORIGINS, {
        webContentsId: 7,
        isMainFrame: true,
        url: `${PACKAGED_ENTRY}#/models?sort=trending`
      })
    ).toEqual({ ok: true })
    const dev: TrustedOrigins = {
      packagedEntry: PACKAGED_ENTRY,
      devOrigin: 'http://localhost:5173'
    }
    expect(
      checkSenderTrust(dev, {
        webContentsId: 3,
        isMainFrame: true,
        url: 'http://localhost:5173/#/history'
      })
    ).toEqual({ ok: true })
  })
})

describe('resolveTrustedOrigins', () => {
  it('keeps the packaged file entry and drops the dev origin when packaged', () => {
    const origins = resolveTrustedOrigins(true, 'E:\\Apps\\HubFetch\\out\\renderer\\index.html')
    expect(origins.packagedEntry.startsWith('file:///')).toBe(true)
    expect(origins.devOrigin).toBeNull()
  })

  it('exposes the dev origin only in non-packaged runs', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    try {
      const origins = resolveTrustedOrigins(false, 'E:\\dev\\out\\renderer\\index.html')
      expect(origins.devOrigin).toBe('http://localhost:5173')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('decideExternalTarget', () => {
  it('opens allowlisted HTTPS destinations externally', () => {
    expect(decideExternalTarget('https://github.com/OranImp/HubFetch')).toBe('open-external')
    expect(decideExternalTarget('https://huggingface.co/models')).toBe('open-external')
    expect(decideExternalTarget('https://evil.example/path?q=1')).toBe('open-external')
  })

  it('denies plaintext, credential-bearing, and internal-scheme targets', () => {
    expect(decideExternalTarget('http://evil.example/')).toBe('deny')
    expect(decideExternalTarget('https://user:pass@evil.example/')).toBe('deny')
    expect(decideExternalTarget('javascript:alert(1)')).toBe('deny')
    expect(decideExternalTarget('file:///C:/Windows/win.ini')).toBe('deny')
    expect(decideExternalTarget('hubfetch://repo/?kind=model&repoId=a/b&path=c.png')).toBe('deny')
    expect(decideExternalTarget('not a url')).toBe('deny')
    expect(decideExternalTarget('')).toBe('deny')
  })

  it('permits the configured Hub endpoint over plaintext HTTP (reverse proxy)', () => {
    expect(decideExternalTarget('http://127.0.0.1:7890/api', 'http://127.0.0.1:7890')).toBe(
      'open-external'
    )
    expect(decideExternalTarget('http://127.0.0.1:9999/', 'http://127.0.0.1:7890')).toBe('deny')
  })
})

describe('permissionCheckAllowed', () => {
  it('denies every permission from an untrusted frame', () => {
    for (const permission of [
      'media',
      'geolocation',
      'notifications',
      'fullscreen',
      'clipboard-write',
      'clipboard-sanitized-write'
    ]) {
      expect(permissionCheckAllowed(false, permission)).toBe(false)
    }
  })

  it('allows only clipboard writes from the trusted app frame', () => {
    expect(permissionCheckAllowed(true, 'clipboard-write')).toBe(true)
    expect(permissionCheckAllowed(true, 'clipboard-sanitized-write')).toBe(true)
    expect(permissionCheckAllowed(true, 'media')).toBe(false)
    expect(permissionCheckAllowed(true, 'geolocation')).toBe(false)
    expect(permissionCheckAllowed(true, 'notifications')).toBe(false)
    expect(permissionCheckAllowed(true, 'fullscreen')).toBe(false)
    expect(permissionCheckAllowed(true, 'camera')).toBe(false)
    expect(permissionCheckAllowed(true, 'microphone')).toBe(false)
  })
})

describe('sanitized logging', () => {
  it('logs only protocol and hostname, never the query string or path', () => {
    expect(sanitizedHost('https://evil.example/a?token=secret#frag')).toBe('https://evil.example')
    expect(sanitizedHost('data:text/html,<h1>x</h1>')).toBe('<invalid-url>')
    expect(sanitizedHost('')).toBe('<invalid-url>')
  })

  it('emits sanitized boundary and IPC-denial warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      logBoundary('will-navigate', 'https://evil.example/repo?token=abc', 'deny')
      logIpcDenial('system:openExternal', 42, 'untrusted-url')
      expect(warn).toHaveBeenCalledWith('[boundary] will-navigate deny target=https://evil.example')
      expect(warn).toHaveBeenCalledWith(
        '[ipc-guard] denied invoke system:openExternal sender=42 reason=untrusted-url'
      )
    } finally {
      warn.mockRestore()
    }
  })
})
