/**
 * OpenAI adapter — native OpenAI SDK integration for connection testing and
 * translation.
 *
 * Constructed with the configured API key and proxy snapshot. Each method
 * builds a client using the provided config (modelId, optional baseUrl).
 * Uses HubFetch's proxied fetch, 60-second timeout, and zero automatic retries.
 *
 * Error mapping (never leaks headers, key, full provider body, or secret-bearing URL):
 *   401 → auth
 *   403 → forbidden
 *   404 → model-not-found
 *   429 → rate-limited
 *   5xx → provider-unavailable
 *   timeout → timeout
 *   cancel → canceled
 *   network/other → provider-unavailable / unknown
 */
import OpenAI from 'openai'
import type {
  LlmErrorCode,
  LlmProviderConfig,
  LlmTestConnectionResult,
  LlmTranslateRequest,
  LlmTranslateResult,
} from '@hubfetch/shared'
import type { ProxySnapshot } from '@hubfetch/shared'
import { createProxiedFetch } from '../hub'
import type { LlmAdapter } from './adapter'
import { resolveBaseUrl } from './config'
import { buildTranslationPrompt } from './prompt'
import { parseTranslationResponse } from './parser'

/** Minimal probe messages — requests the literal token "OK". */
const PROBE_MESSAGES: OpenAI.Chat.ChatCompletionMessageParam[] = [
  { role: 'user', content: 'Respond with exactly the word OK and nothing else.' },
]

export class OpenAIAdapter implements LlmAdapter {
  readonly provider = 'openai' as const
  private readonly modelId: string
  private readonly baseUrl: string | null

  constructor(
    private readonly apiKey: string,
    private readonly proxy: ProxySnapshot,
    modelId: string,
    baseUrl: string | null = null,
  ) {
    this.modelId = modelId
    this.baseUrl = baseUrl
  }

  async testConnection(
    config: LlmProviderConfig,
    signal: AbortSignal,
  ): Promise<LlmTestConnectionResult> {
    const start = Date.now()
    try {
      const client = this.buildClient(config)
      const response = await client.chat.completions.create(
        {
          model: config.modelId,
          messages: PROBE_MESSAGES,
          max_tokens: 10,
          temperature: 0,
          stream: false,
        },
        { signal },
      )
      const text = response.choices[0]?.message?.content
      if (!text || text.trim().length === 0) {
        return { ok: false, error: 'empty-response' }
      }
      return { ok: true, latencyMs: Date.now() - start }
    } catch (err) {
      return { ok: false, error: mapOpenAIError(err) }
    }
  }

  async translate(
    request: LlmTranslateRequest,
    signal: AbortSignal,
  ): Promise<LlmTranslateResult> {
    return this.translateWithConfig(request, { modelId: this.modelId, baseUrl: this.baseUrl }, signal)
  }

  /**
   * Full translate method that accepts resolved config directly.
   * Used by the coordinator (Todo 9) after resolving provider config.
   */
  async translateWithConfig(
    request: LlmTranslateRequest,
    config: LlmProviderConfig,
    signal: AbortSignal,
  ): Promise<LlmTranslateResult> {
    try {
      const client = this.buildClient(config)
      const prompt = buildTranslationPrompt(request.markdown, request.targetLocale)
      const response = await client.chat.completions.create(
        {
          model: config.modelId,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 4096,
          temperature: 0,
          stream: false,
        },
        { signal },
      )
      const text = response.choices[0]?.message?.content
      if (!text || text.trim().length === 0) {
        return { status: 'error', error: 'empty-response' }
      }
      const parsed = parseTranslationResponse(text)
      if (!parsed.ok) {
        return { status: 'error', error: parsed.error }
      }
      return parsed.result
    } catch (err) {
      return { status: 'error', error: mapOpenAIError(err) }
    }
  }

  /** Build an OpenAI client for the given config. */
  private buildClient(config: LlmProviderConfig): OpenAI {
    const baseURL = resolveBaseUrl('openai', config)
    return new OpenAI({
      apiKey: this.apiKey,
      baseURL,
      fetch: createProxiedFetch(this.proxy),
      timeout: 60_000,
      maxRetries: 0,
    })
  }
}

/**
 * Map an OpenAI SDK error to a closed LlmErrorCode.
 * Never leaks headers, key, full provider body, or secret-bearing URL.
 */
export function mapOpenAIError(err: unknown): LlmErrorCode {
  if (err instanceof OpenAI.APIUserAbortError) {
    return 'canceled'
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return 'timeout'
  }
  if (err instanceof OpenAI.APIConnectionError) {
    // Network-level failure (DNS, refused, etc.) — not auth-related.
    return 'provider-unavailable'
  }
  if (err instanceof OpenAI.AuthenticationError) {
    return 'auth'
  }
  if (err instanceof OpenAI.PermissionDeniedError) {
    return 'forbidden'
  }
  if (err instanceof OpenAI.NotFoundError) {
    return 'model-not-found'
  }
  if (err instanceof OpenAI.RateLimitError) {
    return 'rate-limited'
  }
  if (err instanceof OpenAI.InternalServerError) {
    return 'provider-unavailable'
  }
  if (err instanceof OpenAI.APIError) {
    // Fallback for other API errors: map by status code.
    switch (err.status) {
      case 401:
        return 'auth'
      case 403:
        return 'forbidden'
      case 404:
        return 'model-not-found'
      case 429:
        return 'rate-limited'
      default:
        if (err.status !== undefined && err.status >= 500) {
          return 'provider-unavailable'
        }
        return 'unknown'
    }
  }
  // Non-OpenAI errors (e.g. JSON parse failures in our code)
  return 'unknown'
}