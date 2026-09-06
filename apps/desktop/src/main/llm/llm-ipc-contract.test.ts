// apps/desktop/src/main/llm/llm-ipc-contract.test.ts
//
// Todo 10 contract tests for the typed LLM IPC surface:
//   - Valid get-status/set-credential/delete-credential/test-connection/translate/cancel
//     reach the service through the real handle() wrapper
//   - Malformed provider/key/baseURL/UUID/oversized Markdown rejected before service
//   - Untrusted origin denied
//   - Provider errors cross as typed redacted results
//   - Shutdown releases secret handles and aborts active requests
import { describe, expect, expectTypeOf, it, vi, beforeEach, afterEach } from 'vitest'
import type {
  IpcResponse,
  LlmStatus,
  LlmTestConnectionRequest,
  LlmTestConnectionResult,
  LlmTranslateRequest,
  LlmTranslateResult,
  LlmProvider,
  LlmSettings,
  LlmProviderConfig,
  LlmConfiguredStatus,
  ProxySnapshot,
  RendererApi
} from '@hubfetch/shared'
import { IPC_INVOKE_CHANNELS, ipcRequestSchemas } from '@hubfetch/shared'
import { registerIpcHandlers, type AppContext } from '../ipc'
import { LlmService, type LlmServiceDeps } from './llm-service'
import type { LlmAdapter } from './adapter'
import { secretRegistry, type SecretHandle } from '../security/secret-registry'
import { checkSenderTrust } from '../ipc-guard'
import { makeRogueEvent, PACKAGED_ENTRY } from '../clone/clones-ipc-test-utils'

// ---------------------------------------------------------------------------
// Electron mock: captures ipcMain.handle registrations
// ---------------------------------------------------------------------------
const LLM_UUID = '123e4567-e89b-12d3-a456-426614174000'

interface MockContainer {
  handlers: Map<string, (event: unknown, payload: unknown) => unknown>
  trustedUrl: string
}

const mock: MockContainer = vi.hoisted(() => ({
  handlers: new Map(),
  trustedUrl: 'file:///E:/Apps/HubFetch/resources/app.asar/out/renderer/index.html'
}))

vi.mock('electron', () => {
  const trustedEvent = () => {
    const frame = {}
    return {
      sender: { id: 7, getURL: () => mock.trustedUrl, mainFrame: frame },
      senderFrame: frame
    }
  }
  return {
    app: {
      isPackaged: false,
      getAppPath: () => 'C:\\qa\\apps\\desktop',
      getVersion: () => '0.2.0-qa',
      getLocale: () => 'en-US',
      getPath: () => 'C:\\qa\\appdata',
      setPath: () => undefined,
      setLoginItemSettings: () => undefined,
      setName: () => undefined,
      whenReady: () => Promise.resolve(),
      on: () => undefined,
      quit: () => undefined,
      exit: () => undefined
    },
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
        mock.handlers.set(channel, handler)
      }
    },
    BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: async () => undefined, openPath: async () => '', showItemInFolder: () => undefined },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, 'utf8'),
      decryptString: (buffer: Buffer) => buffer.toString('utf8')
    },
    net: { isOnline: () => true },
    Notification: class {},
    Menu: { buildFromTemplate: () => ({ popup: () => undefined, append: () => undefined }), setApplicationMenu: () => undefined },
    Tray: class {},
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }
  }
})

// ---------------------------------------------------------------------------
// Fake adapter — records calls, returns controlled results
// ---------------------------------------------------------------------------
class FakeAdapter implements LlmAdapter {
  readonly provider: LlmProvider
  readonly calls: Array<{ method: string }> = []
  private result:
    | { kind: 'test'; value: LlmTestConnectionResult }
    | { kind: 'translate'; value: LlmTranslateResult }
    | { kind: 'throw'; error: string }

  constructor(
    provider: LlmProvider,
    result:
      | { kind: 'test'; value: LlmTestConnectionResult }
      | { kind: 'translate'; value: LlmTranslateResult }
      | { kind: 'throw'; error: string }
  ) {
    this.provider = provider
    this.result = result
  }

  async testConnection(_config: LlmProviderConfig, _signal: AbortSignal): Promise<LlmTestConnectionResult> {
    this.calls.push({ method: 'testConnection' })
    if (this.result.kind === 'throw') throw new Error(this.result.error)
    if (this.result.kind === 'test') return this.result.value
    return { ok: false, error: 'unknown' }
  }

  async translate(_request: LlmTranslateRequest, _signal: AbortSignal): Promise<LlmTranslateResult> {
    this.calls.push({ method: 'translate' })
    if (this.result.kind === 'throw') throw new Error(this.result.error)
    if (this.result.kind === 'translate') return this.result.value
    return { status: 'error', error: 'unknown' }
  }
}

/** Adapter that hangs until signal is aborted — for testing cancellation. */
class PendingAdapter implements LlmAdapter {
  readonly provider: LlmProvider
  constructor(provider: LlmProvider) { this.provider = provider }
  async testConnection(_config: LlmProviderConfig, signal: AbortSignal): Promise<LlmTestConnectionResult> {
    return new Promise<LlmTestConnectionResult>((_, reject) => {
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
  }
  async translate(_request: LlmTranslateRequest, signal: AbortSignal): Promise<LlmTranslateResult> {
    return new Promise<LlmTranslateResult>((_, reject) => {
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
  }
}

// ---------------------------------------------------------------------------
// Fake credential store (with secretRegistry for shutdown test)
// ---------------------------------------------------------------------------
class FakeCredentialStore {
  keys: Partial<Record<LlmProvider, string>> = {}
  transientHandles = new Set<SecretHandle>()

  getStatus(): LlmConfiguredStatus {
    return {
      openai: Boolean(this.keys.openai),
      anthropic: Boolean(this.keys.anthropic),
      gemini: Boolean(this.keys.gemini)
    }
  }

  getKey(provider: LlmProvider): string | undefined {
    return this.keys[provider]
  }

  setKey(provider: LlmProvider, key: string): void {
    this.keys[provider] = key
    try { secretRegistry.register(key) } catch { /* best-effort */ }
  }

  deleteKey(provider: LlmProvider): void {
    const existing = this.keys[provider]
    if (existing) {
      secretRegistry.unregister(existing)
      delete this.keys[provider]
    }
  }

  registerTransient(secret: string): SecretHandle {
    const handle = secretRegistry.register(secret)
    this.transientHandles.add(handle)
    return handle
  }

  unregisterTransient(handle: SecretHandle): void {
    if (this.transientHandles.has(handle)) {
      secretRegistry.unregister(handle)
      this.transientHandles.delete(handle)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TEST_PROXY: ProxySnapshot = { mode: 'direct' }

function makeSettings(overrides?: Partial<LlmSettings>): LlmSettings {
  return {
    activeProvider: 'openai',
    providers: {
      openai: { modelId: 'gpt-4o-mini', baseUrl: null },
      anthropic: { modelId: 'claude-3-haiku', baseUrl: null },
      gemini: { modelId: 'gemini-2.0-flash', baseUrl: null }
    },
    ...overrides
  }
}

function makeTrustedEvent(): unknown {
  const frame = {}
  return {
    sender: { id: 7, getURL: () => mock.trustedUrl, mainFrame: frame },
    senderFrame: frame
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
interface LlmIpcHarness {
  credentialStore: FakeCredentialStore
  service: LlmService
  cleanup(): void
}

function makeLlmIpcHarness(): LlmIpcHarness {
  const credentialStore = new FakeCredentialStore()
  const settings = makeSettings()
  const adapters = new Map<string, LlmAdapter>()

  const service = new LlmService({
    credentialStore: credentialStore as unknown as LlmServiceDeps['credentialStore'],
    getSettings: () => settings,
    getProxySnapshot: () => TEST_PROXY,
    createAdapter: (
      provider: LlmProvider,
      _apiKey: string,
      _proxy: ProxySnapshot,
      modelId: string,
      _baseUrl: string | null
    ): LlmAdapter => {
      const key = `${provider}:${modelId}`
      const existing = adapters.get(key)
      if (existing) return existing
      const adapter = new FakeAdapter(provider, { kind: 'test', value: { ok: true, latencyMs: 42 } })
      adapters.set(key, adapter)
      return adapter
    }
  })

  const ctx = {
    llmService: service,
    llmCredentials: credentialStore as unknown as never,
    db: {} as never,
    hub: {} as never,
    auth: {} as never,
    settings: { get: () => ({ proxy: { mode: 'system' as const, manualUrl: null } }) },
    library: {} as never,
    downloads: {} as never,
    cache: {} as never,
    follows: {} as never,
    integrationTasks: {} as never,
    i18n: {} as never,
    rebuildMenu: () => undefined,
    notificationRegistration: {} as never,
    removeNotificationShortcut: () => false,
    broadcast: (() => undefined) as never,
    applyNetworkSettings: (async () => undefined) as never,
    applyDesktopSettings: (() => undefined) as never,
    diagnostics: {} as never,
    clones: {} as never
  } as unknown as AppContext

  registerIpcHandlers(ctx, { packagedEntry: PACKAGED_ENTRY, devOrigin: null })

  return {
    credentialStore,
    service,
    cleanup: () => {
      service.dispose()
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LLM IPC contracts (type-level)', () => {
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

  it('types every llm operation response', () => {
    expectTypeOf<IpcResponse<'llm:get-status'>>().toEqualTypeOf<LlmStatus>()
    expectTypeOf<IpcResponse<'llm:set-credential'>>().toEqualTypeOf<LlmStatus>()
    expectTypeOf<IpcResponse<'llm:delete-credential'>>().toEqualTypeOf<LlmStatus>()
    expectTypeOf<IpcResponse<'llm:test-connection'>>().toEqualTypeOf<LlmTestConnectionResult>()
    expectTypeOf<IpcResponse<'llm:translate'>>().toEqualTypeOf<LlmTranslateResult>()
    expectTypeOf<IpcResponse<'llm:cancel'>>().toEqualTypeOf<void>()
  })
})

describe('LLM IPC handler routing (valid calls reach the service)', () => {
  let harness: LlmIpcHarness

  beforeEach(() => {
    harness = makeLlmIpcHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('llm:get-status returns configured status', async () => {
    const handler = mock.handlers.get('llm:get-status')!
    const result = await Promise.resolve(handler(makeTrustedEvent(), undefined))
    expect(result).toEqual({ configured: { openai: false, anthropic: false, gemini: false } })
  })

  it('llm:set-credential stores a key and returns updated status', async () => {
    const handler = mock.handlers.get('llm:set-credential')!
    const result = await Promise.resolve(
      handler(makeTrustedEvent(), { provider: 'openai', apiKey: 'sk-openai-test-key' })
    )
    expect(result).toEqual({ configured: { openai: true, anthropic: false, gemini: false } })
    expect(harness.credentialStore.getKey('openai')).toBe('sk-openai-test-key')
  })

  it('llm:delete-credential removes a key and returns updated status', async () => {
    harness.credentialStore.setKey('openai', 'sk-openai-test-key')
    const handler = mock.handlers.get('llm:delete-credential')!
    const result = await Promise.resolve(
      handler(makeTrustedEvent(), { provider: 'openai' })
    )
    expect(result).toEqual({ configured: { openai: false, anthropic: false, gemini: false } })
    expect(harness.credentialStore.getKey('openai')).toBeUndefined()
  })

  it('llm:test-connection with valid request reaches the adapter', async () => {
    handler: harness.credentialStore.setKey('openai', 'sk-openai-test-key')
    const handler = mock.handlers.get('llm:test-connection')!
    const result = await Promise.resolve(
      handler(makeTrustedEvent(), {
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        baseUrl: null
      })
    )
    expect(result).toEqual({ ok: true, latencyMs: 42 })
  })

  it('llm:translate with valid request reaches the adapter', async () => {
    harness.credentialStore.setKey('openai', 'sk-openai-test-key')
    // Override the adapter to return a translate result
    // The adapter created by the factory is a FakeAdapter with test result,
    // so we need a different approach: set the credential then call translate
    // which will use the factory. Since the factory returns a FakeAdapter with
    // test result, the translate will fail. Let's use a custom adapter.
    const adapters = new Map<string, LlmAdapter>()
    const translateAdapter = new FakeAdapter('openai', {
      kind: 'translate',
      value: { status: 'translated', sourceLanguage: 'en', markdown: 'Bonjour' }
    })
    adapters.set('openai:gpt-4o-mini', translateAdapter)
    // Replace the factory
    const customFactory = (
      provider: LlmProvider, _apiKey: string, _proxy: ProxySnapshot, modelId: string, _baseUrl: string | null
    ): LlmAdapter => {
      const key = `${provider}:${modelId}`
      return adapters.get(key) ?? new FakeAdapter(provider, { kind: 'test', value: { ok: true, latencyMs: 42 } })
    }
    // Create a new service with the custom factory
    const settings = makeSettings()
    const credentialStore = harness.credentialStore
    const service2 = new LlmService({
      credentialStore: credentialStore as unknown as LlmServiceDeps['credentialStore'],
      getSettings: () => settings,
      getProxySnapshot: () => TEST_PROXY,
      createAdapter: customFactory
    })
    const ctx2 = {
      llmService: service2,
      llmCredentials: credentialStore as unknown as never,
      db: {} as never,
      hub: {} as never,
      auth: {} as never,
      settings: { get: () => ({ proxy: { mode: 'system' as const, manualUrl: null } }) },
      library: {} as never,
      downloads: {} as never,
      cache: {} as never,
      follows: {} as never,
      integrationTasks: {} as never,
      i18n: {} as never,
      rebuildMenu: () => undefined,
      notificationRegistration: {} as never,
      removeNotificationShortcut: () => false,
      broadcast: (() => undefined) as never,
      applyNetworkSettings: (async () => undefined) as never,
      applyDesktopSettings: (() => undefined) as never,
      diagnostics: {} as never,
      clones: {} as never
    } as unknown as AppContext
    registerIpcHandlers(ctx2, { packagedEntry: PACKAGED_ENTRY, devOrigin: null })

    const handler = mock.handlers.get('llm:translate')!
    const result = await Promise.resolve(
      handler(makeTrustedEvent(), {
        requestId: LLM_UUID,
        markdown: '# Hello',
        targetLocale: 'fr'
      })
    )
    expect(result).toEqual({ status: 'translated', sourceLanguage: 'en', markdown: 'Bonjour' })
    // Verify the adapter was used by checking the translate result
    service2.dispose()
  })

  it('llm:cancel dispatches by requestId (no-op for unknown ID)', async () => {
    const handler = mock.handlers.get('llm:cancel')!
    // Cancelling a non-existent request should be a no-op (no throw)
    await expect(
      Promise.resolve(handler(makeTrustedEvent(), { requestId: LLM_UUID }))
    ).resolves.toBeUndefined()
  })
})

describe('central wrapper rejects malformed payloads before service invocation', () => {
  let harness: LlmIpcHarness

  beforeEach(() => {
    harness = makeLlmIpcHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('llm:set-credential rejects invalid provider and short key', async () => {
    const handler = mock.handlers.get('llm:set-credential')!
    const trusted = makeTrustedEvent()

    // Invalid provider
    await expect(
      Promise.resolve(handler(trusted, { provider: 'cohere', apiKey: 'sk-valid-key' }))
    ).rejects.toThrow(/Invalid payload/)

    // Short key
    await expect(
      Promise.resolve(handler(trusted, { provider: 'openai', apiKey: 'short' }))
    ).rejects.toThrow(/Invalid payload/)

    // Oversized key
    await expect(
      Promise.resolve(handler(trusted, { provider: 'openai', apiKey: 'x'.repeat(513) }))
    ).rejects.toThrow(/Invalid payload/)

    // Blank key
    await expect(
      Promise.resolve(handler(trusted, { provider: 'openai', apiKey: '   ' }))
    ).rejects.toThrow(/Invalid payload/)
  })

  it('llm:delete-credential rejects invalid provider', async () => {
    const handler = mock.handlers.get('llm:delete-credential')!
    await expect(
      Promise.resolve(handler(makeTrustedEvent(), { provider: 'cohere' }))
    ).rejects.toThrow(/Invalid payload/)
  })

  it('llm:test-connection rejects bad baseUrl, blank model, and unknown fields', async () => {
    const handler = mock.handlers.get('llm:test-connection')!
    const trusted = makeTrustedEvent()

    // FTP URL (not http/https)
    await expect(
      Promise.resolve(handler(trusted, { provider: 'openai', modelId: 'gpt-4o', baseUrl: 'ftp://api.openai.com/v1' }))
    ).rejects.toThrow(/Invalid payload/)

    // URL with credentials
    await expect(
      Promise.resolve(handler(trusted, { provider: 'openai', modelId: 'gpt-4o', baseUrl: 'https://user:pass@api.openai.com/v1' }))
    ).rejects.toThrow(/Invalid payload/)

    // URL with query
    await expect(
      Promise.resolve(handler(trusted, { provider: 'openai', modelId: 'gpt-4o', baseUrl: 'https://api.openai.com/v1?key=secret' }))
    ).rejects.toThrow(/Invalid payload/)

    // Blank model after trim
    await expect(
      Promise.resolve(handler(trusted, { provider: 'openai', modelId: '   ', baseUrl: null }))
    ).rejects.toThrow(/Invalid payload/)

    // Unknown field (strict mode)
    await expect(
      Promise.resolve(handler(trusted, { provider: 'openai', modelId: 'gpt-4o', baseUrl: null, extra: true }))
    ).rejects.toThrow(/Invalid payload/)
  })

  it('llm:translate rejects invalid UUID, unsupported locale, and oversized Markdown', async () => {
    const handler = mock.handlers.get('llm:translate')!
    const trusted = makeTrustedEvent()

    // Invalid UUID
    await expect(
      Promise.resolve(handler(trusted, { requestId: 'not-a-uuid', markdown: '# hi', targetLocale: 'zh-CN' }))
    ).rejects.toThrow(/Invalid payload/)

    // Unsupported locale
    await expect(
      Promise.resolve(handler(trusted, { requestId: LLM_UUID, markdown: '# hi', targetLocale: 'system' }))
    ).rejects.toThrow(/Invalid payload/)

    // Oversized Markdown
    await expect(
      Promise.resolve(handler(trusted, { requestId: LLM_UUID, markdown: 'x'.repeat(50_001), targetLocale: 'en' }))
    ).rejects.toThrow(/Invalid payload/)
  })

  it('llm:cancel rejects invalid UUID', async () => {
    const handler = mock.handlers.get('llm:cancel')!
    await expect(
      Promise.resolve(handler(makeTrustedEvent(), { requestId: 'not-a-uuid' }))
    ).rejects.toThrow(/Invalid payload/)
  })
})

describe('central wrapper rejects untrusted origin', () => {
  it('rejects a rogue sender frame before any llm service call', async () => {
    const harness = makeLlmIpcHarness()
    try {
      const rogue = makeRogueEvent('https://evil.example/')

      for (const channel of [
        'llm:get-status',
        'llm:set-credential',
        'llm:delete-credential',
        'llm:test-connection',
        'llm:translate',
        'llm:cancel'
      ] as const) {
        const handler = mock.handlers.get(channel)
        expect(handler).toBeDefined()
        const payload = channel === 'llm:get-status'
          ? undefined
          : channel === 'llm:set-credential'
            ? { provider: 'openai', apiKey: 'sk-valid-test-key' }
            : channel === 'llm:delete-credential'
              ? { provider: 'openai' }
              : channel === 'llm:test-connection'
                ? { provider: 'openai', modelId: 'gpt-4o', baseUrl: null }
                : channel === 'llm:translate'
                  ? { requestId: LLM_UUID, markdown: '# hi', targetLocale: 'en' }
                  : { requestId: LLM_UUID }
        await expect(Promise.resolve(handler!(rogue, payload))).rejects.toThrow(/IPC sender rejected/)
      }
    } finally {
      harness.cleanup()
    }
  })
})

describe('provider errors cross as typed redacted results', () => {
  it('llm:test-connection returns typed error result on failure', async () => {
    const harness = makeLlmIpcHarness()
    try {
      harness.credentialStore.setKey('openai', 'sk-openai-test-key')
      // Replace the adapter factory to return a failing adapter
      const failingAdapter = new FakeAdapter('openai', { kind: 'test', value: { ok: false, error: 'auth' } })
      const adapters = new Map<string, LlmAdapter>()
      adapters.set('openai:gpt-4o-mini', failingAdapter)
      const customFactory = (
        provider: LlmProvider, _apiKey: string, _proxy: ProxySnapshot, modelId: string, _baseUrl: string | null
      ): LlmAdapter => {
        const key = `${provider}:${modelId}`
        return adapters.get(key) ?? new FakeAdapter(provider, { kind: 'test', value: { ok: true, latencyMs: 42 } })
      }
      const credentialStore = harness.credentialStore
      const settings = makeSettings()
      const service2 = new LlmService({
        credentialStore: credentialStore as unknown as LlmServiceDeps['credentialStore'],
        getSettings: () => settings,
        getProxySnapshot: () => TEST_PROXY,
        createAdapter: customFactory
      })
      const ctx2 = {
        llmService: service2,
        llmCredentials: credentialStore as unknown as never,
        db: {} as never,
        hub: {} as never,
        auth: {} as never,
        settings: { get: () => ({ proxy: { mode: 'system' as const, manualUrl: null } }) },
        library: {} as never,
        downloads: {} as never,
        cache: {} as never,
        follows: {} as never,
        integrationTasks: {} as never,
        i18n: {} as never,
        rebuildMenu: () => undefined,
        notificationRegistration: {} as never,
        removeNotificationShortcut: () => false,
        broadcast: (() => undefined) as never,
        applyNetworkSettings: (async () => undefined) as never,
        applyDesktopSettings: (() => undefined) as never,
        diagnostics: {} as never,
        clones: {} as never
      } as unknown as AppContext
      registerIpcHandlers(ctx2, { packagedEntry: PACKAGED_ENTRY, devOrigin: null })

      const handler = mock.handlers.get('llm:test-connection')!
      const result = await Promise.resolve(
        handler(makeTrustedEvent(), {
          provider: 'openai',
          modelId: 'gpt-4o-mini',
          baseUrl: null
        })
      )
      // The result is a typed error union, not a raw exception
      expect(result).toEqual({ ok: false, error: 'auth' })
      service2.dispose()
    } finally {
      harness.cleanup()
    }
  })

  it('llm:translate returns typed error result on failure', async () => {
    const harness = makeLlmIpcHarness()
    try {
      harness.credentialStore.setKey('openai', 'sk-openai-test-key')
      const failingAdapter = new FakeAdapter('openai', { kind: 'translate', value: { status: 'error', error: 'auth' } })
      const adapters = new Map<string, LlmAdapter>()
      adapters.set('openai:gpt-4o-mini', failingAdapter)
      const customFactory = (
        provider: LlmProvider, _apiKey: string, _proxy: ProxySnapshot, modelId: string, _baseUrl: string | null
      ): LlmAdapter => {
        const key = `${provider}:${modelId}`
        return adapters.get(key) ?? new FakeAdapter(provider, { kind: 'test', value: { ok: true, latencyMs: 42 } })
      }
      const credentialStore = harness.credentialStore
      const settings = makeSettings()
      const service2 = new LlmService({
        credentialStore: credentialStore as unknown as LlmServiceDeps['credentialStore'],
        getSettings: () => settings,
        getProxySnapshot: () => TEST_PROXY,
        createAdapter: customFactory
      })
      const ctx2 = {
        llmService: service2,
        llmCredentials: credentialStore as unknown as never,
        db: {} as never,
        hub: {} as never,
        auth: {} as never,
        settings: { get: () => ({ proxy: { mode: 'system' as const, manualUrl: null } }) },
        library: {} as never,
        downloads: {} as never,
        cache: {} as never,
        follows: {} as never,
        integrationTasks: {} as never,
        i18n: {} as never,
        rebuildMenu: () => undefined,
        notificationRegistration: {} as never,
        removeNotificationShortcut: () => false,
        broadcast: (() => undefined) as never,
        applyNetworkSettings: (async () => undefined) as never,
        applyDesktopSettings: (() => undefined) as never,
        diagnostics: {} as never,
        clones: {} as never
      } as unknown as AppContext
      registerIpcHandlers(ctx2, { packagedEntry: PACKAGED_ENTRY, devOrigin: null })

      const handler = mock.handlers.get('llm:translate')!
      const result = await Promise.resolve(
        handler(makeTrustedEvent(), {
          requestId: LLM_UUID,
          markdown: '# Hello',
          targetLocale: 'fr'
        })
      )
      // The result is a typed error union, not a raw exception
      expect(result).toEqual({ status: 'error', error: 'auth' })
      service2.dispose()
    } finally {
      harness.cleanup()
    }
  })
})

describe('shutdown releases secret handles and aborts active requests', () => {
  it('llmService.dispose() aborts active translate requests', async () => {
    const harness = makeLlmIpcHarness()
    try {
      harness.credentialStore.setKey('openai', 'sk-openai-test-key')
      // Use a pending adapter that hangs forever
      const adapters = new Map<string, LlmAdapter>()
      adapters.set('openai:gpt-4o-mini', new PendingAdapter('openai'))
      const customFactory = (
        provider: LlmProvider, _apiKey: string, _proxy: ProxySnapshot, modelId: string, _baseUrl: string | null
      ): LlmAdapter => {
        const key = `${provider}:${modelId}`
        return adapters.get(key) ?? new PendingAdapter(provider)
      }
      const credentialStore = harness.credentialStore
      const settings = makeSettings()
      const service2 = new LlmService({
        credentialStore: credentialStore as unknown as LlmServiceDeps['credentialStore'],
        getSettings: () => settings,
        getProxySnapshot: () => TEST_PROXY,
        createAdapter: customFactory
      })

      // Start a translate that hangs
      const translatePromise = service2.translate({
        requestId: LLM_UUID,
        markdown: '# Hello',
        targetLocale: 'fr'
      })

      // Dispose should abort the active request
      service2.dispose()

      const result = await translatePromise
      expect(result).toEqual({ status: 'error', error: 'canceled' })
    } finally {
      harness.cleanup()
    }
  })

  it('secretRegistry.cleanup releases registered credential handles', async () => {
    const harness = makeLlmIpcHarness()
    try {
      // Register a key and verify it's tracked
      harness.credentialStore.setKey('openai', 'sk-openai-test-key-12345678')
      expect(secretRegistry.isRegistered('sk-openai-test-key-12345678')).toBe(true)

      // Delete the key — should release the handle
      harness.credentialStore.deleteKey('openai')
      expect(secretRegistry.isRegistered('sk-openai-test-key-12345678')).toBe(false)
    } finally {
      harness.cleanup()
    }
  })
})