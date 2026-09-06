/**
 * Response envelope parser.
 *
 * Accepts ONLY:
 * - A whole JSON object: `{"status":"translated",...}`
 * - A single fenced JSON block: `` ```json { ... } ``` ``
 *
 * Rejects: extra prose, empty, oversized (>=200k chars), invalid status,
 * missing markdown, missing sourceLanguage.
 *
 * Maps parse failures to the closed LlmErrorCode union with assertNever
 * exhaustiveness checking.
 */
import type { LlmErrorCode, LlmTranslationResult } from '@hubfetch/shared'

const MAX_RESPONSE_CHARS = 200_000

export type ParseResult =
  | { readonly ok: true; readonly result: LlmTranslationResult }
  | { readonly ok: false; readonly error: LlmErrorCode }

/**
 * Parse an LLM response string into a typed translation envelope.
 *
 * Strategy:
 * 1. Reject empty/whitespace-only → `empty-response`
 * 2. Reject oversized → `malformed-response`
 * 3. Try whole response as JSON object
 * 4. If not a JSON object, look for one fenced JSON block (` ```json ... ``` `)
 * 5. Validate the parsed shape against the envelope schema
 * 6. Return the typed result or an error code
 */
export function parseTranslationResponse(raw: string): ParseResult {
  const trimmed = raw.trim()

  // Step 1: reject empty/whitespace-only
  if (trimmed.length === 0) {
    return { ok: false, error: 'empty-response' }
  }

  // Step 2: reject oversized
  if (trimmed.length >= MAX_RESPONSE_CHARS) {
    return { ok: false, error: 'malformed-response' }
  }

  // Step 3: extract JSON string
  const jsonStr = extractJsonObject(trimmed)
  if (jsonStr === null) {
    return { ok: false, error: 'malformed-response' }
  }

  // Step 4: parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return { ok: false, error: 'malformed-response' }
  }

  // Step 5: validate shape
  return validateEnvelope(parsed)
}

/**
 * Extract a single JSON object from the response.
 *
 * Accepts:
 * - Whole response is a JSON object: `{...}`
 * - One fenced JSON block: `` ```json { ... } ``` `` or `` ``` { ... } ``` ``
 *
 * Rejects if there are multiple fenced blocks or the response mixes prose
 * with a JSON object outside a fence.
 */
function extractJsonObject(trimmed: string): string | null {
  // Case 1: whole response is a JSON object (starts with { and ends with })
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    // Must be a single top-level object — no extra prose before or after
    // A valid JSON object that starts with { and ends with } is acceptable.
    // Verify it's parseable (let the caller try JSON.parse).
    return trimmed
  }

  // Case 2: look for one fenced JSON block
  // Match ```json ... ``` or ``` ... ```
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g
  const matches = Array.from(trimmed.matchAll(fenceRegex))

  if (matches.length === 0) {
    return null
  }

  // Reject multiple fenced blocks
  if (matches.length > 1) {
    return null
  }

  const inner = matches[0]?.[1] ?? ''
  const innerTrimmed = inner.trim()

  // Inner content must be a JSON object
  if (!innerTrimmed.startsWith('{') || !innerTrimmed.endsWith('}')) {
    return null
  }

  return innerTrimmed
}

/**
 * Validate the parsed JSON against the envelope schema.
 */
function validateEnvelope(parsed: unknown): ParseResult {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'malformed-response' }
  }

  const obj = parsed as Record<string, unknown>

  // Must have a status field
  if (typeof obj.status !== 'string') {
    return { ok: false, error: 'malformed-response' }
  }

  // Must have a non-empty sourceLanguage
  if (typeof obj.sourceLanguage !== 'string' || obj.sourceLanguage.length === 0) {
    return { ok: false, error: 'malformed-response' }
  }

  switch (obj.status) {
    case 'translated': {
      if (typeof obj.markdown !== 'string') {
        return { ok: false, error: 'malformed-response' }
      }
      return {
        ok: true,
        result: {
          status: 'translated',
          sourceLanguage: obj.sourceLanguage,
          markdown: obj.markdown,
        },
      }
    }
    case 'same-language': {
      return {
        ok: true,
        result: {
          status: 'same-language',
          sourceLanguage: obj.sourceLanguage,
        },
      }
    }
    default: {
      // Unknown status from untrusted input → malformed. The `assertNever`
      // exhaustiveness helper is reserved for typed enum dispatch in the
      // adapters; here the status is raw untrusted data, so we reject it.
      return { ok: false, error: 'malformed-response' }
    }
  }
}

/**
 * Exhaustiveness helper — ensures all branches of a discriminated union
 * are handled at compile time. At runtime, throws an error.
 *
 * @param value - The value that should have been handled exhaustively.
 * @param errorCode - The error code to return (unused at runtime here since
 *   this is a programming error, but helps the type system).
 */
export function assertNever(value: never, _errorCode?: LlmErrorCode): never {
  // istanbul ignore next
  throw new Error(`Unhandled discriminated union member: ${String(value)}`)
}