/**
 * Fuzz / property tests for the redactor (plan Todo 22 acceptance).
 *
 * Deterministic seeded PRNG (mulberry32) drives randomized inputs that embed a
 * registered, non-pattern sentinel in values, keys, URLs, headers, and error
 * chains. Every output artifact must be free of the sentinel bytes, redaction
 * must be deterministic and idempotent, and output must stay JSON-safe.
 */
import { describe, expect, it } from 'vitest'
import { Redactor, REDACTED } from './redaction'
import { SecretRegistry } from './secret-registry'

/** Deterministic PRNG so failures reproduce byte-for-byte. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SENTINEL = 'kqz-93mX7vQw2tRz-sentinel'
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_=/&:.@? '

function randomString(rng: () => number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(rng() * ALPHABET.length)]
  }
  return out
}

function embedSentinel(rng: () => number, text: string): string {
  if (rng() < 0.5) return `${text}${SENTINEL}`
  if (rng() < 0.6) return `${SENTINEL}${text}`
  const at = Math.floor(rng() * (text.length + 1))
  return text.slice(0, at) + SENTINEL + text.slice(at)
}

/** Build a random nested structure with the sentinel buried somewhere. */
function randomValue(rng: () => number, depth: number): unknown {
  const roll = rng()
  if (depth <= 0 || roll < 0.25) {
    const variant = Math.floor(rng() * 5)
    switch (variant) {
      case 0:
        return embedSentinel(rng, randomString(rng, 1 + Math.floor(rng() * 40)))
      case 1:
        return Math.floor(rng() * 1000)
      case 2:
        return rng() < 0.5
      case 3:
        return `https://alice:${embedSentinel(rng, randomString(rng, 8))}@example.com/x?token=${embedSentinel(rng, randomString(rng, 6))}`
      default:
        return `Authorization: Bearer ${embedSentinel(rng, randomString(rng, 12))}`
    }
  }
  if (roll < 0.6) {
    return Array.from({ length: 1 + Math.floor(rng() * 6) }, () => randomValue(rng, depth - 1))
  }
  const obj: Record<string, unknown> = {}
  const count = 1 + Math.floor(rng() * 5)
  for (let i = 0; i < count; i++) {
    const key =
      rng() < 0.25
        ? embedSentinel(rng, randomString(rng, 6))
        : randomString(rng, 4 + Math.floor(rng() * 8))
    obj[key] = randomValue(rng, depth - 1)
  }
  if (rng() < 0.2) obj.token = SENTINEL
  return obj
}

describe('Redactor fuzz — sentinel never survives', () => {
  const registry = new SecretRegistry()
  const redactor = new Redactor(registry)
  // A non-pattern sentinel (no hf_ prefix) must only be removed because it is
  // registered by exact value — the fuzz proves the value registry, not the
  // regex layer, is doing the work.
  registry.register(SENTINEL)
  const needle = Buffer.from(SENTINEL, 'utf8')

  const expectNoSentinelBytes = (artifact: string): void => {
    expect(Buffer.from(artifact, 'utf8').includes(needle)).toBe(false)
  }

  it('leaves no sentinel in any randomized text artifact (300 seeds)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rng = mulberry32(seed)
      const text = embedSentinel(rng, randomString(rng, 5 + Math.floor(rng() * 120)))
      const out = redactor.redactText(text)
      expectNoSentinelBytes(out)
      // Idempotence and determinism.
      expect(redactor.redactText(out)).toBe(out)
      expect(redactor.redactText(text)).toBe(redactor.redactText(text))
    }
  })

  it('leaves no sentinel in randomized structured values (200 seeds)', () => {
    for (let seed = 500; seed < 700; seed++) {
      const rng = mulberry32(seed)
      const value = randomValue(rng, 4)
      const out = redactor.redactValue(value)
      const serialized = JSON.stringify(out)
      expectNoSentinelBytes(serialized)
      expect(redactor.redactValue(out)).toEqual(out)
    }
  })

  it('leaves no sentinel in randomized error chains (100 seeds)', () => {
    for (let seed = 900; seed < 1000; seed++) {
      const rng = mulberry32(seed)
      const root = new Error(embedSentinel(rng, randomString(rng, 30)))
      const mid = new Error(randomString(rng, 10))
      ;(mid as { cause?: unknown }).cause = root
      const top = new Error(`https://user:${embedSentinel(rng, randomString(rng, 10))}@host/x`)
      ;(top as { cause?: unknown }).cause = mid
      const rendered = redactor.redactError(top)
      expectNoSentinelBytes(rendered)
      expect(rendered).toContain(REDACTED)
    }
  })

  it('never throws on adversarial structured inputs', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const inputs: unknown[] = [
      cyclic,
      { deep: cyclic, token: SENTINEL },
      [{ list: [cyclic] }],
      new Date('invalid-date'),
      Symbol('x'),
      0n,
      Buffer.from([0xff, 0xfe, 0x00]),
      new Map([['token', SENTINEL]]),
      new Set([SENTINEL]),
      /secret-token-pattern/g
    ]
    for (const input of inputs) {
      let out: unknown
      expect(() => {
        out = redactor.redactValue(input)
      }).not.toThrow()
      expectNoSentinelBytes(JSON.stringify(out ?? null))
    }
  })

  it('redacts the sentinel inside sensitive header names in text fuzz', () => {
    const rng = mulberry32(42)
    for (let i = 0; i < 50; i++) {
      const text = `Cookie: session=${embedSentinel(rng, randomString(rng, 20))}; theme=dark`
      expectNoSentinelBytes(redactor.redactText(text))
    }
  })
})
