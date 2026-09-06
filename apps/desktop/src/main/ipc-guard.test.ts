import { describe, expect, it, vi } from 'vitest'
import { IPC_INVOKE_CHANNELS, ipcRequestSchemas, settingsExportFileSchema } from '@hubfetch/shared'
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

const LLM_UUID = '123e4567-e89b-12d3-a456-426614174000'
const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com'
const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com'

const llmSchemas: Record<string, { safeParse: (payload: unknown) => { success: boolean; data?: unknown } } | undefined> =
  ipcRequestSchemas

function parseOrThrow(channel: string, payload: unknown): unknown {
  const schema = llmSchemas[channel]
  if (!schema) throw new Error(`missing schema for ${channel}`)
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new Error(`Invalid payload for ${channel}`)
  return parsed.data
}

describe('LLM IPC request schemas', () => {
  it('registers the six llm channels on the invoke allowlist', () => {
    for (const channel of [
      'llm:get-status',
      'llm:set-credential',
      'llm:delete-credential',
      'llm:test-connection',
      'llm:translate',
      'llm:cancel'
    ] as const) {
      expect(IPC_INVOKE_CHANNELS).toContain(channel)
    }
  })

  it('rejects malformed provider and base URL before any handler runs', () => {
    const handler = vi.fn()
    const run = (payload: unknown): void => {
      const data = parseOrThrow('llm:test-connection', payload)
      handler(data)
    }

    expect(() =>
      run({
        provider: 'huggingface',
        modelId: 'gpt-4o-mini',
        baseUrl: null
      })
    ).toThrow(/Invalid payload/)
    expect(() =>
      run({
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        baseUrl: 'ftp://api.openai.com/v1'
      })
    ).toThrow(/Invalid payload/)
    expect(() =>
      run({
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        baseUrl: 'https://user:pass@api.openai.com/v1'
      })
    ).toThrow(/Invalid payload/)
    expect(() =>
      run({
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1?key=secret'
      })
    ).toThrow(/Invalid payload/)
    expect(() =>
      run({
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1#frag'
      })
    ).toThrow(/Invalid payload/)
    expect(handler).not.toHaveBeenCalled()

    expect(
      llmSchemas['llm:test-connection']?.safeParse({
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        baseUrl: null
      }).success
    ).toBe(true)
    expect(
      llmSchemas['llm:test-connection']?.safeParse({
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-0',
        baseUrl: ANTHROPIC_DEFAULT_BASE,
        apiKey: 'sk-ant-test-key-value'
      }).success
    ).toBe(true)
  })

  it('rejects invalid UUID, unsupported locale, blank model, and oversized Markdown', () => {
    const translate = llmSchemas['llm:translate']
    expect(translate).toBeDefined()
    if (!translate) return
    expect(
      translate.safeParse({
        requestId: LLM_UUID,
        markdown: '# hi',
        targetLocale: 'zh-CN'
      }).success
    ).toBe(true)
    expect(
      translate.safeParse({
        requestId: 'not-a-uuid',
        markdown: '# hi',
        targetLocale: 'zh-CN'
      }).success
    ).toBe(false)
    expect(
      translate.safeParse({
        requestId: LLM_UUID,
        markdown: '# hi',
        targetLocale: 'system'
      }).success
    ).toBe(false)
    expect(
      translate.safeParse({
        requestId: LLM_UUID,
        markdown: '# hi',
        targetLocale: 'xx'
      }).success
    ).toBe(false)
    expect(
      translate.safeParse({
        requestId: LLM_UUID,
        markdown: 'x'.repeat(50_001),
        targetLocale: 'en'
      }).success
    ).toBe(false)
    expect(
      translate.safeParse({
        requestId: LLM_UUID,
        markdown: 'x'.repeat(50_000),
        targetLocale: 'en'
      }).success
    ).toBe(true)

    const testConnection = llmSchemas['llm:test-connection']
    expect(testConnection).toBeDefined()
    expect(
      testConnection?.safeParse({ provider: 'openai', modelId: '   ', baseUrl: null }).success
    ).toBe(false)
    expect(
      testConnection?.safeParse({
        provider: 'gemini',
        modelId: '  gemini-2.5-flash  ',
        baseUrl: null
      }).data
    ).toEqual({
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
      baseUrl: null
    })
  })

  it('enforces API-key length bounds and omits keys from settings patches', () => {
    const setCredential = llmSchemas['llm:set-credential']
    expect(setCredential).toBeDefined()
    if (!setCredential) return
    expect(
      setCredential.safeParse({ provider: 'openai', apiKey: 'sk-live-test-key' }).success
    ).toBe(true)
    expect(setCredential.safeParse({ provider: 'openai', apiKey: 'short' }).success).toBe(false)
    expect(setCredential.safeParse({ provider: 'openai', apiKey: 'x'.repeat(513) }).success).toBe(
      false
    )
    expect(setCredential.safeParse({ provider: 'openai', apiKey: '   ' }).success).toBe(false)

    const settingsSet = ipcRequestSchemas['settings:set']!
    expect(
      settingsSet.safeParse({
        patch: {
          llm: {
            activeProvider: 'openai',
            providers: {
              openai: { modelId: 'gpt-4o-mini', baseUrl: null },
              anthropic: { modelId: '', baseUrl: null },
              gemini: { modelId: '', baseUrl: null }
            }
          }
        }
      }).success
    ).toBe(true)
    expect(
      settingsSet.safeParse({
        patch: {
          llm: {
            activeProvider: 'openai',
            providers: {
              openai: { modelId: 'gpt-4o-mini', baseUrl: null, apiKey: 'sk-should-not-appear' },
              anthropic: { modelId: '', baseUrl: null },
              gemini: { modelId: '', baseUrl: null }
            }
          }
        }
      }).success
    ).toBe(false)
    expect(
      settingsExportFileSchema.safeParse({
        version: 1,
        exportedAt: '2026-08-20T00:00:00.000Z',
        settings: {
          llm: {
            activeProvider: 'gemini',
            providers: {
              openai: { modelId: '', baseUrl: null },
              anthropic: { modelId: '', baseUrl: null },
              gemini: { modelId: 'gemini-2.5-flash', baseUrl: GEMINI_DEFAULT_BASE }
            }
          }
        }
      }).success
    ).toBe(true)
  })

  it('accepts credential delete and cancel payloads with closed provider and UUID', () => {
    expect(llmSchemas['llm:delete-credential']?.safeParse({ provider: 'anthropic' }).success).toBe(
      true
    )
    expect(llmSchemas['llm:delete-credential']?.safeParse({ provider: 'cohere' }).success).toBe(false)
    expect(llmSchemas['llm:cancel']?.safeParse({ requestId: LLM_UUID }).success).toBe(true)
    expect(llmSchemas['llm:cancel']?.safeParse({ requestId: 'nope' }).success).toBe(false)
    expect(llmSchemas['llm:get-status']).toBeUndefined()
  })
})
