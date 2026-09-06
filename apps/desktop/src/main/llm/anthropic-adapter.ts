/**
 * AnthropicAdapter — native Anthropic adapter using the official @anthropic-ai/sdk.
 *
 * Constructed with:
 * - apiKey (required)
 * - modelId (required — the model to use for translation)
 * - optional baseURL (defaults to the SDK's built-in https://api.anthropic.com)
 * - optional fetch (for proxy injection or test routing)
 * - optional timeout (default 60_000)
 *
 * maxRetries is hardcoded to 0 — the coordinator owns retry policy.
 *
 * testConnection: minimal messages.create probe requesting literal token "OK"
 * with max_tokens=1 (smallest valid budget). Success = ≥1 non-empty text block.
 *
 * translate: non-streaming messages.create, joins only text content blocks in
 * order, bounded output (max_tokens=4096). Detects refusal (stop_reason=refusal),
 * empty/non-text-only responses. Normalizes API errors/connection/timeout/
 * cancel → LlmAdapterError with shared error codes. Never exposes x-api-key,
 * request headers, or provider response bodies in error output.
 */
import Anthropic from '@anthropic-ai/sdk'
import {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk'
import type { LlmErrorCode } from '@hubfetch/shared'
import type { LlmAdapter } from './adapter'
import type { LlmProviderConfig, LlmTestConnectionResult, LlmTranslateRequest, LlmTranslationResult } from '@hubfetch/shared'
import { buildTranslationPrompt } from './prompt'
import { parseTranslationResponse } from './parser'

// ---------------------------------------------------------------------------
// Typed error for the coordinator to catch
// ---------------------------------------------------------------------------

export class LlmAdapterError extends Error {
  constructor(public readonly code: LlmErrorCode) {
    super(code)
    this.name = 'LlmAdapterError'
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = 'anthropic' as const
  private readonly client: Anthropic
  private readonly modelId: string

  constructor(
    apiKey: string,
    modelId: string,
    opts?: {
      /** Override the SDK default base URL (e.g. http://127.0.0.1:PORT for tests). */
      baseURL?: string
      /** Custom fetch implementation (for proxy injection or test routing). */
      fetch?: typeof fetch
      /** Request timeout in ms (default 60_000). */
      timeout?: number
    },
  ) {
    this.modelId = modelId
    this.client = new Anthropic({
      apiKey,
      baseURL: opts?.baseURL,
      fetch: opts?.fetch,
      timeout: opts?.timeout ?? 60_000,
      maxRetries: 0,
    })
  }

  // -----------------------------------------------------------------------
  // testConnection — minimal generation probe
  // -----------------------------------------------------------------------

  async testConnection(
    config: LlmProviderConfig,
    signal: AbortSignal,
  ): Promise<LlmTestConnectionResult> {
    const start = Date.now()
    try {
      const response = await this.client.messages.create(
        {
          model: config.modelId,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Reply with exactly the single word: OK' }],
        },
        { signal },
      )

      const textBlocks = response.content.filter(
        (b) => b.type === 'text',
      ) as Array<{ type: 'text'; text: string }>
      if (textBlocks.length === 0) {
        return { ok: false, error: 'empty-response' }
      }

      const text = textBlocks.map((b) => b.text).join('')
      if (text.trim().length === 0) {
        return { ok: false, error: 'empty-response' }
      }

      return { ok: true, latencyMs: Date.now() - start }
    } catch (err) {
      return { ok: false, error: mapAnthropicError(err) }
    }
  }

  // -----------------------------------------------------------------------
  // translate — non-streaming, text-block extraction, bounded output
  // -----------------------------------------------------------------------

  async translate(
    request: LlmTranslateRequest,
    signal: AbortSignal,
  ): Promise<LlmTranslationResult> {
    const prompt = buildTranslationPrompt(request.markdown, request.targetLocale)

    let response: Anthropic.Message
    try {
      response = await this.client.messages.create(
        {
          model: this.modelId,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal },
      )
    } catch (err) {
      throw new LlmAdapterError(mapAnthropicError(err))
    }

    // Detect refusal via stop_reason
    if (response.stop_reason === 'refusal') {
      throw new LlmAdapterError('refused')
    }

    // Extract only text content blocks, joined in order
    const textBlocks = response.content.filter(
      (b) => b.type === 'text',
    ) as Array<{ type: 'text'; text: string }>
    if (textBlocks.length === 0) {
      throw new LlmAdapterError('empty-response')
    }

    const fullText = textBlocks.map((b) => b.text).join('')
    if (fullText.trim().length === 0) {
      throw new LlmAdapterError('empty-response')
    }

    // Parse the response envelope
    const parsed = parseTranslationResponse(fullText)
    if (!parsed.ok) {
      throw new LlmAdapterError(parsed.error)
    }

    return parsed.result
  }
}

// ---------------------------------------------------------------------------
// Error mapping — normalizes SDK errors to shared LlmErrorCode
// ---------------------------------------------------------------------------

function mapAnthropicError(err: unknown): LlmErrorCode {
  // Order matters: subclasses must be checked before their parent classes.
  if (err instanceof APIConnectionTimeoutError) {
    return 'timeout'
  }
  if (err instanceof APIUserAbortError) {
    return 'canceled'
  }
  if (err instanceof AuthenticationError) {
    return 'auth'
  }
  if (err instanceof PermissionDeniedError) {
    return 'forbidden'
  }
  if (err instanceof NotFoundError) {
    return 'model-not-found'
  }
  if (err instanceof RateLimitError) {
    return 'rate-limited'
  }
  if (err instanceof InternalServerError) {
    return 'provider-unavailable'
  }
  if (err instanceof APIError) {
    // Catch-all for other API errors (400, 409, 422, etc.)
    if (err.status !== undefined && err.status >= 500) {
      return 'provider-unavailable'
    }
    return 'unknown'
  }
  if (err instanceof APIConnectionError) {
    return 'provider-unavailable'
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return 'canceled'
  }
  return 'unknown'
}