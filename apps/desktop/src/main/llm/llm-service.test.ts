/**
 * Todo 9 — LlmService: coordinator, connection test, cancellation registry.
 *
 * Uses local fakes for the 3 adapters. Tests only LlmService logic
 * (credential delegation, cancellation, supersession), not adapter
 * implementations. No real HTTP calls.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type {
  LlmAdapter,
} from './adapter'
import type {
  LlmConfiguredStatus,
  LlmErrorCode,
  LlmProvider,
  LlmProviderConfig,
  LlmSettings,
  LlmStatus,
  LlmTestConnectionRequest,
  LlmTestConnectionResult,
  LlmTranslateRequest,
  LlmTranslateResult,
  ProxySnapshot,
} from '@hubfetch/shared'
import type { SecretHandle } from '../security/secret-registry'
import { LlmService } from './llm-service'

// ---------------------------------------------------------------------------
// Fake adapter — records calls, returns controlled results
// ---------------------------------------------------------------------------

interface FakeAdapterCall {
  method: 'testConnection' | 'translate'
  config?: LlmProviderConfig
  request?: LlmTranslateRequest
  signal: AbortSignal
}

class FakeAdapter implements LlmAdapter {
  readonly provider: LlmProvider
  readonly calls: FakeAdapterCall[] = []
  private result:
    | { kind: 'test'; value: LlmTestConnectionResult }
    | { kind: 'translate'; value: LlmTranslateResult }
    | { kind: 'throw'; error: LlmErrorCode }

  constructor(
    provider: LlmProvider,
    result:
      | { kind: 'test'; value: LlmTestConnectionResult }
      | { kind: 'translate'; value: LlmTranslateResult }
      | { kind: 'throw'; error: LlmErrorCode },
  ) {
    this.provider = provider
    this.result = result
  }

  static forTest(
    provider: LlmProvider,
    result: LlmTestConnectionResult,
  ): FakeAdapter {
    return new FakeAdapter(provider, { kind: 'test', value: result })
  }

  static forTranslate(
    provider: LlmProvider,
    result: LlmTranslateResult,
  ): FakeAdapter {
    return new FakeAdapter(provider, { kind: 'translate', value: result })
  }

  static forThrow(provider: LlmProvider, error: LlmErrorCode): FakeAdapter {
    return new FakeAdapter(provider, { kind: 'throw', error })
  }

  async testConnection(
    config: LlmProviderConfig,
    signal: AbortSignal,
  ): Promise<LlmTestConnectionResult> {
    this.calls.push({ method: 'testConnection', config, signal })
    if (this.result.kind === 'throw') throw new FakeAdapterError(this.result.error)
    if (this.result.kind === 'test') return this.result.value
    return { ok: false, error: 'unknown' }
  }

  async translate(
    request: LlmTranslateRequest,
    signal: AbortSignal,
  ): Promise<LlmTranslateResult> {
    this.calls.push({ method: 'translate', request, signal })
    if (this.result.kind === 'throw') throw new FakeAdapterError(this.result.error)
    if (this.result.kind === 'translate') return this.result.value
    return { status: 'error', error: 'unknown' }
  }
}

/** Adapter that hangs until the signal is aborted — for testing cancellation. */
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

/** Error shaped like AnthropicAdapter's LlmAdapterError — has a `.code` property. */
class FakeAdapterError extends Error {
  readonly code: LlmErrorCode
  constructor(code: LlmErrorCode) {
    super(code)
    this.name = 'LlmAdapterError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Fake credential store
// ---------------------------------------------------------------------------

class FakeCredentialStore {
  keys: Partial<Record<LlmProvider, string>> = {}
  transientHandles = new Set<SecretHandle>()
  private nextHandle = 1

  getStatus(): LlmConfiguredStatus {
    return {
      openai: Boolean(this.keys.openai),
      anthropic: Boolean(this.keys.anthropic),
      gemini: Boolean(this.keys.gemini),
    }
  }

  getKey(provider: LlmProvider): string | undefined {
    return this.keys[provider]
  }

  setKey(provider: LlmProvider, key: string): void {
    this.keys[provider] = key
  }

  deleteKey(provider: LlmProvider): void {
    delete this.keys[provider]
  }

  registerTransient(_secret: string): SecretHandle {
    const handle = `transient-${this.nextHandle++}` as unknown as SecretHandle
    this.transientHandles.add(handle)
    return handle
  }

  unregisterTransient(handle: SecretHandle): void {
    this.transientHandles.delete(handle)
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
      gemini: { modelId: 'gemini-2.0-flash', baseUrl: null },
    },
    ...overrides,
  }
}

function translateRequest(
  overrides?: Partial<LlmTranslateRequest>,
): LlmTranslateRequest {
  return {
    requestId: 'test-req-1',
    markdown: '# Hello',
    targetLocale: 'fr',
    ...overrides,
  }
}

function testConnectionRequest(
  overrides?: Partial<LlmTestConnectionRequest>,
): LlmTestConnectionRequest {
  return {
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    baseUrl: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LlmService', () => {
  let credentialStore: FakeCredentialStore
  let settings: LlmSettings
  let adapters: Map<string, LlmAdapter>
  let service: LlmService

  function createAdapter(
    provider: LlmProvider,
    _apiKey: string,
    _proxy: ProxySnapshot,
    modelId: string,
    _baseUrl: string | null,
  ): LlmAdapter {
    const key = `${provider}:${modelId}`
    const existing = adapters.get(key)
    if (existing) return existing
    const adapter = FakeAdapter.forTest(provider, { ok: true, latencyMs: 42 })
    adapters.set(key, adapter)
    return adapter
  }

  beforeEach(() => {
    credentialStore = new FakeCredentialStore()
    settings = makeSettings()
    adapters = new Map()
    service = new LlmService({
      credentialStore: credentialStore as any,
      getSettings: () => settings,
      getProxySnapshot: () => TEST_PROXY,
      createAdapter,
    })
  })

  afterEach(() => {
    service.dispose()
  })

  // -----------------------------------------------------------------------
  // getStatus
  // -----------------------------------------------------------------------

  describe('getStatus', () => {
    it('returns configured booleans from credential store', () => {
      credentialStore.setKey('openai', 'sk-xxx')
      const status: LlmStatus = service.getStatus()
      expect(status.configured.openai).toBe(true)
      expect(status.configured.anthropic).toBe(false)
      expect(status.configured.gemini).toBe(false)
    })

    it('returns all false when no keys are stored', () => {
      const status: LlmStatus = service.getStatus()
      expect(status.configured.openai).toBe(false)
      expect(status.configured.anthropic).toBe(false)
      expect(status.configured.gemini).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // setCredential / deleteCredential
  // -----------------------------------------------------------------------

  describe('setCredential', () => {
    it('delegates to credential store', () => {
      service.setCredential('openai', 'sk-xxx')
      expect(credentialStore.getKey('openai')).toBe('sk-xxx')
    })
  })

  describe('deleteCredential', () => {
    it('delegates to credential store', () => {
      credentialStore.setKey('openai', 'sk-xxx')
      service.deleteCredential('openai')
      expect(credentialStore.getKey('openai')).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // testConnection
  // -----------------------------------------------------------------------

  describe('testConnection', () => {
    it('uses transient key when provided', async () => {
      const adapter = FakeAdapter.forTest('openai', { ok: true, latencyMs: 42 })
      adapters.set('openai:gpt-4o-mini', adapter)

      const result = await service.testConnection(
        testConnectionRequest({ apiKey: 'sk-transient' }),
      )

      expect(result).toEqual({ ok: true, latencyMs: 42 })
      expect(adapter.calls).toHaveLength(1)
      expect(adapter.calls[0]!.config!.modelId).toBe('gpt-4o-mini')
    })

    it('falls back to saved key when no transient key', async () => {
      credentialStore.setKey('openai', 'sk-saved')
      const adapter = FakeAdapter.forTest('openai', { ok: true, latencyMs: 42 })
      adapters.set('openai:gpt-4o-mini', adapter)

      const result = await service.testConnection(testConnectionRequest())

      expect(result).toEqual({ ok: true, latencyMs: 42 })
      expect(adapter.calls).toHaveLength(1)
    })

    it('returns not-configured when no key available', async () => {
      const result = await service.testConnection(testConnectionRequest())
      expect(result).toEqual({ ok: false, error: 'not-configured' })
    })

    it('unregisters transient key after success', async () => {
      const adapter = FakeAdapter.forTest('openai', { ok: true, latencyMs: 42 })
      adapters.set('openai:gpt-4o-mini', adapter)

      const before = credentialStore.transientHandles.size
      await service.testConnection(
        testConnectionRequest({ apiKey: 'sk-transient' }),
      )
      expect(credentialStore.transientHandles.size).toBe(before)
    })

    it('unregisters transient key after failure', async () => {
      const adapter = FakeAdapter.forTest('openai', {
        ok: false,
        error: 'auth',
      })
      adapters.set('openai:gpt-4o-mini', adapter)

      const before = credentialStore.transientHandles.size
      await service.testConnection(
        testConnectionRequest({ apiKey: 'sk-transient' }),
      )
      expect(credentialStore.transientHandles.size).toBe(before)
    })

    it('unregisters transient key when adapter throws', async () => {
      const adapter = FakeAdapter.forThrow('openai', 'auth')
      adapters.set('openai:gpt-4o-mini', adapter)

      const before = credentialStore.transientHandles.size
      await expect(
        service.testConnection(
          testConnectionRequest({ apiKey: 'sk-transient' }),
        ),
      ).rejects.toThrow()
      expect(credentialStore.transientHandles.size).toBe(before)
    })

    it('passes the configured modelId to the adapter', async () => {
      const adapter = FakeAdapter.forTest('openai', { ok: true, latencyMs: 42 })
      adapters.set('openai:gpt-4o-mini', adapter)
      credentialStore.setKey('openai', 'sk-saved')

      await service.testConnection(
        testConnectionRequest({ modelId: 'gpt-4o-mini' }),
      )

      expect(adapter.calls[0]!.config!.modelId).toBe('gpt-4o-mini')
    })

    it('passes custom baseUrl to the adapter', async () => {
      const adapter = FakeAdapter.forTest('openai', { ok: true, latencyMs: 42 })
      adapters.set('openai:gpt-4o-mini', adapter)
      credentialStore.setKey('openai', 'sk-saved')

      await service.testConnection(
        testConnectionRequest({
          baseUrl: 'http://localhost:8080/v1',
        }),
      )

      expect(adapter.calls[0]!.config!.baseUrl).toBe('http://localhost:8080/v1')
    })
  })

  // -----------------------------------------------------------------------
  // translate — provider dispatch
  // -----------------------------------------------------------------------

  describe('translate', () => {
    it('dispatches to OpenAI adapter when active provider is openai', async () => {
      settings = makeSettings({ activeProvider: 'openai' })
      credentialStore.setKey('openai', 'sk-openai')
      const adapter = FakeAdapter.forTranslate('openai', {
        status: 'translated',
        sourceLanguage: 'en',
        markdown: 'Bonjour',
      })
      adapters.set('openai:gpt-4o-mini', adapter)

      const result = await service.translate(translateRequest())

      expect(result).toEqual({
        status: 'translated',
        sourceLanguage: 'en',
        markdown: 'Bonjour',
      })
      expect(adapter.calls).toHaveLength(1)
      expect(adapter.calls[0]!.method).toBe('translate')
    })

    it('dispatches to Anthropic adapter when active provider is anthropic', async () => {
      settings = makeSettings({ activeProvider: 'anthropic' })
      credentialStore.setKey('anthropic', 'sk-ant-xxx')
      const adapter = FakeAdapter.forTranslate('anthropic', {
        status: 'translated',
        sourceLanguage: 'en',
        markdown: 'Bonjour',
      })
      adapters.set('anthropic:claude-3-haiku', adapter)

      const result = await service.translate(translateRequest())

      expect(result).toEqual({
        status: 'translated',
        sourceLanguage: 'en',
        markdown: 'Bonjour',
      })
      expect(adapter.calls).toHaveLength(1)
    })

    it('dispatches to Gemini adapter when active provider is gemini', async () => {
      settings = makeSettings({ activeProvider: 'gemini' })
      credentialStore.setKey('gemini', 'AIza-xxx')
      const adapter = FakeAdapter.forTranslate('gemini', {
        status: 'translated',
        sourceLanguage: 'en',
        markdown: 'Bonjour',
      })
      adapters.set('gemini:gemini-2.0-flash', adapter)

      const result = await service.translate(translateRequest())

      expect(result).toEqual({
        status: 'translated',
        sourceLanguage: 'en',
        markdown: 'Bonjour',
      })
      expect(adapter.calls).toHaveLength(1)
    })

    it('returns invalid-config when active provider has no modelId', async () => {
      settings = makeSettings({
        activeProvider: 'openai',
        providers: {
          openai: { modelId: '', baseUrl: null },
          anthropic: { modelId: 'claude-3-haiku', baseUrl: null },
          gemini: { modelId: 'gemini-2.0-flash', baseUrl: null },
        },
      })
      credentialStore.setKey('openai', 'sk-openai')

      const result = await service.translate(translateRequest())
      expect(result).toEqual({ status: 'error', error: 'invalid-config' })
    })

    it('returns not-configured when active provider has no saved key', async () => {
      settings = makeSettings({ activeProvider: 'openai' })

      const result = await service.translate(translateRequest())
      expect(result).toEqual({ status: 'error', error: 'not-configured' })
    })

    it('does NOT fall back to another provider when active provider fails', async () => {
      settings = makeSettings({ activeProvider: 'openai' })
      credentialStore.setKey('openai', 'sk-openai')
      credentialStore.setKey('anthropic', 'sk-ant-xxx')
      const openaiAdapter = FakeAdapter.forTranslate('openai', {
        status: 'error',
        error: 'auth',
      })
      adapters.set('openai:gpt-4o-mini', openaiAdapter)

      const result = await service.translate(translateRequest())

      expect(result).toEqual({ status: 'error', error: 'auth' })
      // Anthropic adapter should NOT have been created/called
      expect(adapters.has('anthropic:claude-3-haiku')).toBe(false)
    })

    it('returns same-language result from adapter', async () => {
      settings = makeSettings({ activeProvider: 'openai' })
      credentialStore.setKey('openai', 'sk-openai')
      const adapter = FakeAdapter.forTranslate('openai', {
        status: 'same-language',
        sourceLanguage: 'en',
      })
      adapters.set('openai:gpt-4o-mini', adapter)

      const result = await service.translate(translateRequest())

      expect(result).toEqual({ status: 'same-language', sourceLanguage: 'en' })
    })

    it('returns error result when adapter returns malformed response error', async () => {
      settings = makeSettings({ activeProvider: 'openai' })
      credentialStore.setKey('openai', 'sk-openai')
      const adapter = FakeAdapter.forTranslate('openai', {
        status: 'error',
        error: 'malformed-response',
      })
      adapters.set('openai:gpt-4o-mini', adapter)

      const result = await service.translate(translateRequest())

      expect(result).toEqual({ status: 'error', error: 'malformed-response' })
    })
  })

  // -----------------------------------------------------------------------
  // Cancellation & supersession
  // -----------------------------------------------------------------------

  describe('cancellation', () => {
    it('supersedes existing request with same requestId', async () => {
      settings = makeSettings({ activeProvider: 'openai' })
      credentialStore.setKey('openai', 'sk-openai')

      // Use a pending adapter for the first request so it stays in-flight
      adapters.set('openai:gpt-4o-mini', new PendingAdapter('openai'))
      const promise1 = service.translate(translateRequest({ requestId: 'same-id' }))

      // Replace with a resolving adapter for the second request
      const adapter = FakeAdapter.forTranslate('openai', {
        status: 'translated',
        sourceLanguage: 'en',
        markdown: 'Bonjour',
      })
      adapters.set('openai:gpt-4o-mini', adapter)
      const promise2 = service.translate(translateRequest({ requestId: 'same-id' }))

      const result2 = await promise2
      const result1 = await promise1

      expect(result1).toEqual({ status: 'error', error: 'canceled' })
      expect(result2).toEqual({
        status: 'translated',
        sourceLanguage: 'en',
        markdown: 'Bonjour',
      })
    })

    it('cancel() aborts by requestId', async () => {
      settings = makeSettings({ activeProvider: 'openai' })
      credentialStore.setKey('openai', 'sk-openai')
      adapters.set('openai:gpt-4o-mini', new PendingAdapter('openai'))

      const promise = service.translate(translateRequest({ requestId: 'cancel-me' }))
      service.cancel('cancel-me')

      const result = await promise
      expect(result).toEqual({ status: 'error', error: 'canceled' })
    })

    it('removes map entry after translate completes (success)', async () => {
      settings = makeSettings({ activeProvider: 'openai' })
      credentialStore.setKey('openai', 'sk-openai')
      const adapter = FakeAdapter.forTranslate('openai', {
        status: 'translated',
        sourceLanguage: 'en',
        markdown: 'Bonjour',
      })
      adapters.set('openai:gpt-4o-mini', adapter)

      await service.translate(translateRequest({ requestId: 'cleanup-test' }))

      // Cancel after completion should be a no-op (no crash)
      service.cancel('cleanup-test')
    })

    it('removes map entry after translate fails', async () => {
      settings = makeSettings({ activeProvider: 'openai' })
      credentialStore.setKey('openai', 'sk-openai')
      const adapter = FakeAdapter.forTranslate('openai', {
        status: 'error',
        error: 'auth',
      })
      adapters.set('openai:gpt-4o-mini', adapter)

      await service.translate(translateRequest({ requestId: 'fail-cleanup' }))

      // Cancel after failure should be a no-op
      service.cancel('fail-cleanup')
    })

    it('removes map entry after translate adapter throws', async () => {
      settings = makeSettings({ activeProvider: 'openai' })
      credentialStore.setKey('openai', 'sk-openai')
      const adapter = FakeAdapter.forThrow('openai', 'auth')
      adapters.set('openai:gpt-4o-mini', adapter)

      const result = await service.translate(translateRequest({ requestId: 'throw-cleanup' }))

      expect(result).toEqual({ status: 'error', error: 'auth' })
      service.cancel('throw-cleanup') // no-op, should not crash
    })

    it('dispose() aborts all active requests', async () => {
      settings = makeSettings({ activeProvider: 'openai' })
      credentialStore.setKey('openai', 'sk-openai')
      adapters.set('openai:gpt-4o-mini', new PendingAdapter('openai'))

      const promise = service.translate(translateRequest({ requestId: 'dispose-me' }))
      service.dispose()

      const result = await promise
      expect(result).toEqual({ status: 'error', error: 'canceled' })
    })

    it('empty active map after every outcome', async () => {
      settings = makeSettings({ activeProvider: 'openai' })
      credentialStore.setKey('openai', 'sk-openai')

      // Success
      const successAdapter = FakeAdapter.forTranslate('openai', {
        status: 'translated',
        sourceLanguage: 'en',
        markdown: 'Bonjour',
      })
      adapters.set('openai:gpt-4o-mini', successAdapter)
      await service.translate(translateRequest({ requestId: 's' }))

      // Error
      const errorAdapter = FakeAdapter.forTranslate('openai', {
        status: 'error',
        error: 'auth',
      })
      adapters.set('openai:gpt-4o-mini', errorAdapter)
      await service.translate(translateRequest({ requestId: 'e' }))

      // Cancel
      adapters.set('openai:gpt-4o-mini', new PendingAdapter('openai'))
      const p = service.translate(translateRequest({ requestId: 'c' }))
      service.cancel('c')
      await p

      // After all outcomes, cancel on any of these IDs is a no-op (no crash)
      service.cancel('s')
      service.cancel('e')
      service.cancel('c')
    })
  })
})