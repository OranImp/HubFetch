/**
 * LlmService — main-process LLM coordinator.
 *
 * Owns adapter creation, credential lookup, settings lookup, proxy snapshot,
 * and an active requestId→AbortController map for cancellation/supersession.
 *
 * Does NOT auto-retry or fall back to another provider.
 */
import type {
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
import type { LlmAdapter } from './adapter'
import { LlmAdapterError } from './anthropic-adapter'
import type { LlmCredentialStore } from '../llm-credentials'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmServiceDeps {
  /** Credential store for API key lifecycle. */
  readonly credentialStore: Pick<
    LlmCredentialStore,
    'getKey' | 'getStatus' | 'setKey' | 'deleteKey' | 'registerTransient' | 'unregisterTransient'
  >
  /** Returns the current LLM settings (active provider + provider configs). */
  readonly getSettings: () => LlmSettings
  /** Returns the current proxy snapshot for adapter construction. */
  readonly getProxySnapshot: () => ProxySnapshot
  /**
   * Factory that creates an adapter for the given provider.
   * Injected for testability — production wiring creates real adapters.
   */
  readonly createAdapter: (
    provider: LlmProvider,
    apiKey: string,
    proxy: ProxySnapshot,
    modelId: string,
    baseUrl: string | null,
  ) => LlmAdapter
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class LlmService {
  private readonly activeRequests = new Map<string, AbortController>()

  constructor(private readonly deps: LlmServiceDeps) {}

  // -----------------------------------------------------------------------
  // Status & credential delegation
  // -----------------------------------------------------------------------

  getStatus(): LlmStatus {
    return { configured: this.deps.credentialStore.getStatus() }
  }

  setCredential(provider: LlmProvider, key: string): void {
    this.deps.credentialStore.setKey(provider, key)
  }

  deleteCredential(provider: LlmProvider): void {
    this.deps.credentialStore.deleteKey(provider)
  }

  // -----------------------------------------------------------------------
  // testConnection — one minimal generation probe
  // -----------------------------------------------------------------------

  async testConnection(
    draftConfig: LlmTestConnectionRequest,
  ): Promise<LlmTestConnectionResult> {
    // Register transient key if provided (must be released on every path).
    let transientHandle: ReturnType<LlmCredentialStore['registerTransient']> | undefined
    if (draftConfig.apiKey) {
      transientHandle = this.deps.credentialStore.registerTransient(draftConfig.apiKey)
    }

    try {
      // Resolve key: transient > saved
      const apiKey = draftConfig.apiKey ?? this.deps.credentialStore.getKey(draftConfig.provider)
      if (!apiKey) {
        return { ok: false, error: 'not-configured' }
      }

      const config: LlmProviderConfig = {
        modelId: draftConfig.modelId,
        baseUrl: draftConfig.baseUrl ?? null,
      }

      const adapter = this.deps.createAdapter(
        draftConfig.provider,
        apiKey,
        this.deps.getProxySnapshot(),
        config.modelId,
        config.baseUrl,
      )

      const controller = new AbortController()
      const result = await adapter.testConnection(config, controller.signal)
      return result
    } finally {
      if (transientHandle) {
        this.deps.credentialStore.unregisterTransient(transientHandle)
      }
    }
  }

  // -----------------------------------------------------------------------
  // translate — single provider, no fallback
  // -----------------------------------------------------------------------

  async translate(
    request: LlmTranslateRequest,
  ): Promise<LlmTranslateResult> {
    // Supersede any existing request with the same ID
    const existing = this.activeRequests.get(request.requestId)
    if (existing) {
      existing.abort()
      this.activeRequests.delete(request.requestId)
    }

    const controller = new AbortController()
    this.activeRequests.set(request.requestId, controller)

    try {
      const settings = this.deps.getSettings()
      const provider = settings.activeProvider
      const providerConfig = settings.providers[provider]

      // Validate config
      if (!providerConfig.modelId) {
        return { status: 'error', error: 'invalid-config' }
      }

      // Resolve saved key
      const apiKey = this.deps.credentialStore.getKey(provider)
      if (!apiKey) {
        return { status: 'error', error: 'not-configured' }
      }

      const adapter = this.deps.createAdapter(
        provider,
        apiKey,
        this.deps.getProxySnapshot(),
        providerConfig.modelId,
        providerConfig.baseUrl,
      )

      const result = await adapter.translate(request, controller.signal)
      return result
    } catch (err) {
      // Adapters that throw (e.g. AnthropicAdapter's LlmAdapterError) are
      // caught here and mapped to an error result.
      const code = extractErrorCode(err)
      return { status: 'error', error: code }
    } finally {
      // Only remove if we are still the active controller for this ID
      if (this.activeRequests.get(request.requestId) === controller) {
        this.activeRequests.delete(request.requestId)
      }
    }
  }

  // -----------------------------------------------------------------------
  // Cancellation
  // -----------------------------------------------------------------------

  cancel(requestId: string): void {
    const controller = this.activeRequests.get(requestId)
    if (controller) {
      controller.abort()
      this.activeRequests.delete(requestId)
    }
  }

  /** Abort all active requests and clear the map. */
  dispose(): void {
    for (const controller of this.activeRequests.values()) {
      controller.abort()
    }
    this.activeRequests.clear()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract an LlmErrorCode from an unknown thrown value.
 * Handles LlmAdapterError (AnthropicAdapter), AbortError, and generic errors.
 */
function extractErrorCode(err: unknown): LlmErrorCode {
  if (err instanceof Error) {
    // Check for AbortError (AbortController signal aborted)
    if (err.name === 'AbortError') {
      return 'canceled'
    }
    // Check for LlmAdapterError (AnthropicAdapter throws these)
    if (err instanceof LlmAdapterError) {
      return err.code
    }
    // Fallback: check for code property in unknown error objects
    if ('code' in err && typeof Reflect.get(err, 'code') === 'string') {
      const code = Reflect.get(err, 'code') as string
      if (isLlmErrorCode(code)) return code
    }
  }
  return 'unknown'
}

const LLM_ERROR_CODES = [
  'not-configured',
  'invalid-config',
  'auth',
  'forbidden',
  'model-not-found',
  'rate-limited',
  'timeout',
  'canceled',
  'provider-unavailable',
  'malformed-response',
  'empty-response',
  'refused',
  'input-too-long',
  'unknown',
] as const

function isLlmErrorCode(value: string): value is LlmErrorCode {
  return (LLM_ERROR_CODES as readonly string[]).includes(value)
}