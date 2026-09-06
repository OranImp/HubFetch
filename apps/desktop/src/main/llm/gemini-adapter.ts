/**
 * Gemini REST adapter — implements LlmAdapter through the Gemini Developer API.
 *
 * Authentication: `x-goog-api-key` header only (never `?key=` query param).
 * Transport: injected `fetchImpl` from `createProxiedFetch` (hub.ts).
 * Model normalization: accepts `gemini-*` or `models/gemini-*`, normalizes to
 * `models/gemini-*`.
 * Response parsing: Zod schemas that tolerate unknown additive fields but
 * require the known semantic paths. No retry loop — one request on 500/429.
 */
import type { LlmErrorCode, LlmProviderConfig, LlmTestConnectionResult, LlmTranslateRequest, LlmTranslateResult } from '@hubfetch/shared'
import { z } from 'zod'
import type { LlmAdapter } from './adapter'
import { parseTranslationResponse } from './parser'
import { buildTranslationPrompt } from './prompt'

// ---------------------------------------------------------------------------
// Zod schemas for Gemini generateContent response
// ---------------------------------------------------------------------------

/** A response part that may contain text. */
const textPartSchema = z.object({
  text: z.string()
}).passthrough()

/** A candidate (generation result). */
const candidateSchema = z.object({
  content: z.object({
    parts: z.array(z.union([
      textPartSchema,
      z.record(z.string(), z.unknown())
    ])).optional()
  }).passthrough().optional(),
  finishReason: z.string().optional()
}).passthrough()

/** Prompt-level feedback. */
const promptFeedbackSchema = z.object({
  blockReason: z.string().optional()
}).passthrough()

/** Top-level generateContent response. */
const responseSchema = z.object({
  candidates: z.array(candidateSchema).optional().nullable(),
  promptFeedback: promptFeedbackSchema.optional().nullable()
}).passthrough()

// ---------------------------------------------------------------------------
// Model normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a Gemini model ID. Accepts `gemini-*` or `models/gemini-*`,
 * always returns `models/gemini-*`.
 */
function normalizeGeminiModel(model: string): string {
  const trimmed = model.trim()
  if (trimmed.startsWith('models/')) return trimmed
  return `models/${trimmed}`
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Extract the first non-empty text part from a Gemini generateContent response. */
function parseGeminiResponse(
  rawBody: string
): { ok: true; text: string } | { ok: false; error: LlmErrorCode } {
  // 1. Parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return { ok: false, error: 'malformed-response' }
  }

  // 2. Zod validate — tolerate unknown fields, require known paths
  const result = responseSchema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, error: 'malformed-response' }
  }

  const data = result.data

  // 3. Check prompt-level block
  if (data.promptFeedback?.blockReason) {
    return { ok: false, error: 'refused' }
  }

  // 4. Check candidates existence
  const candidates = data.candidates ?? []
  if (candidates.length === 0) {
    return { ok: false, error: 'empty-response' }
  }

  // 5. Check candidate-level safety finish reasons
  for (const c of candidates) {
    if (c.finishReason === 'SAFETY' || c.finishReason === 'PROHIBITED_CONTENT') {
      return { ok: false, error: 'refused' }
    }
  }

  // 6. Extract text from first candidate's first text part
  const firstCandidate = candidates[0]
  const parts: unknown[] = firstCandidate?.content?.parts ?? []
  let text = ''
  for (const part of parts) {
    if (typeof part === 'object' && part !== null) {
      const p = part as Record<string, unknown>
      if (typeof p.text === 'string' && p.text.length > 0) {
        text = p.text
        break
      }
    }
  }

  if (text.length === 0) {
    return { ok: false, error: 'empty-response' }
  }

  return { ok: true, text }
}

// ---------------------------------------------------------------------------
// HTTP status to error code mapping
// ---------------------------------------------------------------------------

function statusToErrorCode(status: number): LlmErrorCode {
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'model-not-found'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'provider-unavailable'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface GeminiAdapterConfig {
  /** The Gemini API key. Sent as `x-goog-api-key` header only. */
  readonly apiKey: string
  /** Resolved base URL (custom or default). */
  readonly baseUrl: string
  /** Model ID. Accepts `gemini-*` or `models/gemini-*`. */
  readonly modelId: string
  /** Proxied fetch from `createProxiedFetch`. */
  readonly fetchImpl: typeof fetch
  /** Request timeout in milliseconds (default 60_000). */
  readonly timeoutMs?: number
}

/**
 * Create a Gemini REST adapter bound to the given config.
 *
 * The coordinator (Todo 9) creates one adapter per provider config and key.
 * All requests use the bound model, base URL, and API key.
 */
export function createGeminiAdapter(config: GeminiAdapterConfig): LlmAdapter {
  const { apiKey, baseUrl, fetchImpl } = config
  const timeoutMs = config.timeoutMs ?? 60_000
  const modelPath = normalizeGeminiModel(config.modelId)
  const generateContentUrl = `${baseUrl.replace(/\/+$/, '')}/v1beta/${modelPath}:generateContent`

  const provider: LlmAdapter['provider'] = 'gemini'

  // -------------------------------------------------------------------------
  // Shared request helper
  // -------------------------------------------------------------------------

  /**
   * Perform a generateContent POST, parse the response, and extract text.
   * Handles timeout, cancellation, HTTP status, and malformed bodies.
   * No retry loop — exactly one attempt.
   */
  async function generateContent(
    prompt: string,
    signal: AbortSignal
  ): Promise<{ ok: true; text: string } | { ok: false; error: LlmErrorCode }> {
    const timeoutController = new AbortController()
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs)

    let compositeSignal: AbortSignal
    try {
      compositeSignal = AbortSignal.any([signal, timeoutController.signal])
    } catch {
      // AbortSignal.any() may throw if signal is already aborted in some envs.
      // Fall back to the caller's signal.
      compositeSignal = signal
    }

    try {
      const response = await fetchImpl(generateContentUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'text/plain' }
        }),
        signal: compositeSignal
      })

      clearTimeout(timeoutId)

      // Map HTTP error status
      if (!response.ok) {
        return { ok: false, error: statusToErrorCode(response.status) }
      }

      // Parse body
      const rawBody = await response.text()

      // Check for key leakage in body (should never happen; safety check)
      if (rawBody.includes(apiKey)) {
        return { ok: false, error: 'unknown' }
      }

      return parseGeminiResponse(rawBody)
    } catch (err) {
      clearTimeout(timeoutId)

      // Distinguish caller cancellation from timeout
      if (signal.aborted) {
        return { ok: false, error: 'canceled' }
      }
      if (timeoutController.signal.aborted) {
        return { ok: false, error: 'timeout' }
      }

      // Network error, DNS failure, etc.
      return { ok: false, error: 'provider-unavailable' }
    }
  }

  // -------------------------------------------------------------------------
  // Interface methods
  // -------------------------------------------------------------------------

  const adapter: LlmAdapter = {
    provider,

    async testConnection(
      _config: LlmProviderConfig,
      signal: AbortSignal
    ): Promise<LlmTestConnectionResult> {
      const started = Date.now()
      const result = await generateContent('OK', signal)

      if (!result.ok) {
        return { ok: false, error: result.error }
      }

      return { ok: true, latencyMs: Date.now() - started }
    },

    async translate(
      request: LlmTranslateRequest,
      signal: AbortSignal
    ): Promise<LlmTranslateResult> {
      const prompt = buildTranslationPrompt(request.markdown, request.targetLocale)
      const result = await generateContent(prompt, signal)

      if (!result.ok) {
        return { status: 'error', error: result.error }
      }

      // Parse the Gemini text output through the provider-neutral parser
      const parsed = parseTranslationResponse(result.text)
      if (!parsed.ok) {
        return { status: 'error', error: parsed.error }
      }

      return parsed.result
    }
  }

  return adapter
}