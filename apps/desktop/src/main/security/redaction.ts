/**
 * Centralized recursive redaction for main-process logs, diagnostics, errors,
 * and event serialization (plan Todo 22).
 *
 * Ports the archived Python `Redactor` semantics to TypeScript — structural URL
 * userinfo/query redaction, sensitive header/cookie field names, header lines,
 * Git credential lines, AskPass prompts, Hugging Face token patterns, and exact
 * registered-secret substitution — and adds the bounds the plan requires:
 * explicit markers for cycles and binary payloads, depth/string/output caps,
 * error containment, immutability, and deterministic output.
 *
 * One token, `[REDACTED]`, replaces every removed secret. Structural markers
 * (`[Circular]`, `[Truncated]`, `[Binary <n> bytes]`) are separate and never
 * stand in for secret material.
 */
import type { SecretRegistry } from './secret-registry'
import { HUB_CAPABILITY_KEYS } from '@hubfetch/shared'

/** Deterministic placeholder that replaces every removed secret. */
export const REDACTED = '[REDACTED]'
/** Explicit marker for an on-path reference cycle (never a silent skip). */
export const CIRCULAR_MARKER = '[Circular]'
/** Explicit marker for bounded recursion depth (never a silent skip). */
export const TRUNCATED_MARKER = '[Truncated]'
/** Explicit marker for non-decodable binary payloads (never a silent skip). */
export const FUNCTION_MARKER = '[Function]'
export const SYMBOL_MARKER = '[Symbol]'

export class RedactionError extends Error {
  constructor(reason: string) {
    super(`redaction error: ${reason}`)
    this.name = 'RedactionError'
  }
}

export interface RedactorOptions {
  /** Maximum object/array nesting before the output truncates. */
  maxDepth?: number
  /** Output cap for every redacted string (redaction runs first, then cap). */
  maxStringLength?: number
  /** Cap on array items and object keys in one redacted structure. */
  maxChildren?: number
}

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-amz-security-token',
  'x-api-key',
  'x-auth-token'
])

const SENSITIVE_QUERY_NAMES = new Set([
  'access_token',
  'access-token',
  'api_key',
  'apikey',
  'auth',
  'client_secret',
  'credential',
  'key',
  'passwd',
  'password',
  'secret',
  'session_token',
  'sig',
  'signature',
  'token'
])

/** Structured field names whose values are always removed. */
const SENSITIVE_FIELD_NAMES = new Set([...SENSITIVE_HEADER_NAMES, ...SENSITIVE_QUERY_NAMES])

const CREDENTIAL_FIELD_ALTERNATION = 'passphrase|password|token|username'
const HEADER_NAMES_ALTERNATION = [...SENSITIVE_HEADER_NAMES].sort().join('|')

const URL_PATTERN_SOURCE = String.raw`\bhttps?://[^\s<>"']+`
const HF_ACCESS_TOKEN_SOURCE = String.raw`\bhf_[A-Za-z0-9]{20,}\b`
const HF_ORG_TOKEN_SOURCE = String.raw`\bapi_org_[A-Za-z0-9]{20,}\b`
// The capture group keeps the trailing separator so the replacement prefix
// preserves the line structure (`Authorization: `, `password=`, `Password for …: `).
const HEADER_LINE_SOURCE = `^((?:${HEADER_NAMES_ALTERNATION})\\s*:\\s*).*$`
const GIT_CREDENTIAL_LINE_SOURCE = `^(\\s*(?:${CREDENTIAL_FIELD_ALTERNATION})\\s*=\\s*).*$`
const ASKPASS_PROMPT_SOURCE = `^(\\s*(?:${CREDENTIAL_FIELD_ALTERNATION})\\s+for\\s+'[^']*'\\s*:)\\s*\\S.*$`
/** Bearer tokens in free text (context-cued, value itself is opaque). */
const BEARER_PATTERN_SOURCE = String.raw`\b(Bearer|bearer)\s+[^\s,;"']{6,}`
/** Basic base64 credential blobs in free text. */
const BASIC_PATTERN_SOURCE = String.raw`\b(Basic|basic)\s+[A-Za-z0-9+/]{8,}={0,2}`

export class Redactor {
  private readonly registry: SecretRegistry | null
  private readonly maxDepth: number
  private readonly maxStringLength: number
  private readonly maxChildren: number

  constructor(registry?: SecretRegistry | null, options: RedactorOptions = {}) {
    this.registry = registry ?? null
    this.maxDepth = options.maxDepth ?? 16
    this.maxStringLength = options.maxStringLength ?? 4096
    this.maxChildren = options.maxChildren ?? 200
  }

  /** Redact one arbitrary string, combining structural and pattern rules. */
  redactText(text: string): string {
    let value = this.redactUrls(text)
    value = replaceLine(value, HEADER_LINE_SOURCE, '')
    value = replaceLine(value, GIT_CREDENTIAL_LINE_SOURCE, '')
    value = replaceLine(value, ASKPASS_PROMPT_SOURCE, ' ')
    value = value.replace(new RegExp(HF_ACCESS_TOKEN_SOURCE, 'gi'), REDACTED)
    value = value.replace(new RegExp(HF_ORG_TOKEN_SOURCE, 'gi'), REDACTED)
    value = value.replace(
      new RegExp(BEARER_PATTERN_SOURCE, 'g'),
      (_all, word: string) => `${word} ${REDACTED}`
    )
    value = value.replace(
      new RegExp(BASIC_PATTERN_SOURCE, 'g'),
      (_all, word: string) => `${word} ${REDACTED}`
    )
    if (this.registry) {
      // Longest matches first so overlapping registered secrets never fragment.
      for (const secret of this.registry.liveSecrets()) {
        value = value.split(secret).join(REDACTED)
      }
    }
    if (value.length > this.maxStringLength) {
      value = value.slice(0, this.maxStringLength)
    }
    return value
  }

  /** Redact any value recursively into JSON-safe form without mutation. */
  redactValue(value: unknown): unknown {
    return this.redactValueAt(value, 0, new WeakSet<object>())
  }

  /** Render an exception chain with type context and redacted messages. */
  redactError(error: unknown): string {
    try {
      const lines: string[] = []
      const seen = new Set<unknown>()
      // A null/undefined "error" is still rendered deterministically.
      let current: unknown = error === null || error === undefined ? 'null' : error
      while (current !== null && current !== undefined) {
        if (seen.has(current)) break
        seen.add(current)
        lines.push(`${this.errorName(current)}: ${this.errorMessage(current)}`)
        if (current instanceof AggregateError && current.errors.length > 0) {
          for (const nested of current.errors) lines.push(this.redactError(nested))
        }
        const cause = (current as { cause?: unknown }).cause
        if (cause !== null && cause !== undefined) {
          current = cause
          continue
        }
        break
      }
      return this.redactText(lines.join('\n'))
    } catch {
      // Redaction must never throw on a malformed error object.
      return REDACTED
    }
  }

  /** Redacted message of the top-level error (IPC flattens errors to message). */
  redactErrorText(error: unknown): string {
    return this.redactText(this.errorMessage(error))
  }

  private redactValueAt(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined) return null
    switch (typeof value) {
      case 'string':
        return this.redactText(value)
      case 'number':
      case 'boolean':
        return value
      case 'bigint':
        return value.toString()
      case 'symbol':
        return SYMBOL_MARKER
      case 'function':
        return FUNCTION_MARKER
      default:
        break
    }
    if (value instanceof Error) return this.redactError(value)
    if (value instanceof Date)
      return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
    if (value instanceof RegExp) return this.redactText(String(value))
    if (isBinaryView(value)) return this.redactBinary(value)
    if (value instanceof Map) return this.redactMap(value, depth, seen)
    if (value instanceof Set) return this.redactSet(value, depth, seen)
    if (Array.isArray(value)) return this.redactArray(value, depth, seen)
    return this.redactPlainObject(value as Record<string, unknown>, depth, seen)
  }

  private redactMap(value: Map<unknown, unknown>, depth: number, seen: WeakSet<object>): unknown {
    if (seen.has(value)) return CIRCULAR_MARKER
    if (depth >= this.maxDepth) return TRUNCATED_MARKER
    seen.add(value)
    try {
      return [...value.entries()].map(([key, item]) => [
        this.redactValueAt(key, depth + 1, seen),
        this.redactValueAt(item, depth + 1, seen)
      ])
    } finally {
      seen.delete(value)
    }
  }

  private redactSet(value: Set<unknown>, depth: number, seen: WeakSet<object>): unknown {
    if (seen.has(value)) return CIRCULAR_MARKER
    if (depth >= this.maxDepth) return TRUNCATED_MARKER
    seen.add(value)
    try {
      return [...value].map((item) => this.redactValueAt(item, depth + 1, seen))
    } finally {
      seen.delete(value)
    }
  }

  private redactArray(value: unknown[], depth: number, seen: WeakSet<object>): unknown {
    if (seen.has(value)) return CIRCULAR_MARKER
    if (depth >= this.maxDepth) return TRUNCATED_MARKER
    seen.add(value)
    try {
      const out: unknown[] = []
      for (const item of value) {
        if (out.length >= this.maxChildren) {
          out.push(TRUNCATED_MARKER)
          break
        }
        out.push(this.redactValueAt(item, depth + 1, seen))
      }
      return out
    } finally {
      seen.delete(value)
    }
  }

  private redactPlainObject(
    value: Record<string, unknown>,
    depth: number,
    seen: WeakSet<object>
  ): unknown {
    if (seen.has(value)) return CIRCULAR_MARKER
    if (depth >= this.maxDepth) return TRUNCATED_MARKER
    seen.add(value)
    try {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        if (Object.keys(out).length >= this.maxChildren) {
          out[TRUNCATED_MARKER] = TRUNCATED_MARKER
          break
        }
        const redactedKey = this.redactText(key)
        const redactedValue =
          SENSITIVE_FIELD_NAMES.has(key.toLowerCase()) && !isPublicCapabilityKey(key, item)
          ? REDACTED
          : this.redactValueAt(item, depth + 1, seen)
        out[redactedKey] = redactedValue
      }
      return out
    } finally {
      seen.delete(value)
    }
  }

  private redactUrls(text: string): string {
    return text.replace(new RegExp(URL_PATTERN_SOURCE, 'gi'), (match) => this.redactUrl(match))
  }

  private redactUrl(url: string): string {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return url
    }
    let out = url
    // Userinfo: replace exactly the credentials between the scheme and the
    // host, preserving every other byte of the original URL (no path/query
    // normalization — a bare `https://host` must stay byte-identical).
    if (parsed.username !== '' || parsed.password !== '') {
      const schemeEnd = out.indexOf('://') + 3
      const hostIndex = out.toLowerCase().indexOf(parsed.hostname.toLowerCase(), schemeEnd)
      const at = hostIndex > schemeEnd ? out.lastIndexOf('@', hostIndex - 1) : -1
      if (at > schemeEnd) {
        out = `${out.slice(0, schemeEnd)}${REDACTED}${out.slice(at)}`
      }
    }
    // Sensitive query values, surgically.
    if (parsed.search) {
      const qStart = out.indexOf('?')
      if (qStart >= 0) {
        const pairs = out
          .slice(qStart + 1)
          .split('&')
          .map((pair) => {
            const eq = pair.indexOf('=')
            if (eq < 0) return pair
            const name = pair.slice(0, eq)
            if (SENSITIVE_QUERY_NAMES.has(decodeQueryName(name))) return `${name}=${REDACTED}`
            return pair
          })
        out = `${out.slice(0, qStart + 1)}${pairs.join('&')}`
      }
    }
    return out
  }

  private redactBinary(value: ArrayBufferView | ArrayBuffer): string {
    const bytes = value.byteLength
    const buffer =
      value instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(value))
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    const text = buffer.toString('utf8')
    if (text.includes('\uFFFD')) return `[Binary ${bytes} bytes]`
    return this.redactText(text)
  }

  private errorName(error: unknown): string {
    if (error instanceof Error && error.name) return error.name
    if (error === null) return 'Error'
    const ctor = (error as { constructor?: { name?: string } }).constructor
    return typeof ctor?.name === 'string' && ctor.name ? ctor.name : 'Error'
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message || error.name
    if (typeof error === 'string') return error
    return String(error)
  }
}

function isPublicCapabilityKey(fieldName: string, value: unknown): boolean {
  return (
    fieldName === 'key' &&
    typeof value === 'string' &&
    HUB_CAPABILITY_KEYS.some((capabilityKey) => capabilityKey === value)
  )
}

function isBinaryView(value: object): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
}

/** Case-insensitive, percent-decoded query-name lookup. */
function decodeQueryName(name: string): string {
  try {
    return decodeURIComponent(name).toLowerCase()
  } catch {
    return name.toLowerCase()
  }
}

/** Replace the value on every line whose prefix matches the capture group. */
function replaceLine(text: string, source: string, separator: string): string {
  return text.replace(new RegExp(source, 'gim'), (_match, prefix: string) => {
    return `${prefix}${separator}${REDACTED}`
  })
}
