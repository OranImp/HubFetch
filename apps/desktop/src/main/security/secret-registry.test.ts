/**
 * TDD suite for the bounded SecretRegistry lifecycle (plan Todo 22).
 *
 * Opaque handles, reference-counted registration, TTL expiry, minimum useful
 * length, capacity bounds, zeroization on unregister/purge, and the guarantee
 * that the registry is never serialized or exposed. Written FIRST (red phase).
 */
import { describe, expect, it, vi } from 'vitest'
import { Redactor, REDACTED, RedactionError } from './redaction'
import { DEFAULT_MIN_SECRET_LENGTH, SecretRegistry, secretRegistry } from './secret-registry'

const SECRET = 'supersecretvalue-123'

describe('SecretRegistry — registration contract', () => {
  it('returns an opaque handle that never reveals the value', () => {
    const registry = new SecretRegistry()
    const handle = registry.register(SECRET)
    expect(handle).toBeTypeOf('object')
    expect(String(handle)).not.toContain(SECRET)
    expect(JSON.stringify(handle)).not.toContain(SECRET)
  })

  it('rejects empty secrets with a typed error', () => {
    expect(() => new SecretRegistry().register('')).toThrow(RedactionError)
  })

  it('enforces a minimum useful length (default 8)', () => {
    const registry = new SecretRegistry()
    expect(registry.minLength).toBe(DEFAULT_MIN_SECRET_LENGTH)
    expect(() => registry.register('short')).toThrow(RedactionError)
    expect(registry.register('eightsafe')).toBeTypeOf('object')
  })

  it('allows a per-call minimum-length override', () => {
    const registry = new SecretRegistry()
    const handle = registry.register('tiny', { minLength: 3 })
    expect(handle).toBeTypeOf('object')
    expect(registry.isRegistered('tiny')).toBe(true)
  })

  it('enforces a per-instance minimum length', () => {
    const registry = new SecretRegistry({ minLength: 12 })
    expect(() => registry.register('elevenchrs!')).toThrow(RedactionError)
    registry.register('twelvechars!!')
  })

  it('bounds the number of live secrets and the length of each', () => {
    const registry = new SecretRegistry({ maxSecrets: 2, maxSecretLength: 32 })
    registry.register('secret-one-aaaa')
    registry.register('secret-two-bbbb')
    expect(() => registry.register('secret-three-ccc')).toThrow(RedactionError)
    expect(() => registry.register('x'.repeat(33))).toThrow(RedactionError)
  })

  it('rejects registering the redaction token itself', () => {
    const registry = new SecretRegistry()
    expect(() => registry.register(REDACTED)).toThrow(RedactionError)
  })
})

describe('SecretRegistry — reference counting and lifecycle', () => {
  it('reference-counts duplicate registrations of the same value', () => {
    const registry = new SecretRegistry()
    const h1 = registry.register(SECRET)
    const h2 = registry.register(SECRET)
    expect(registry.isRegistered(SECRET)).toBe(true)

    expect(registry.unregister(h1)).toBe(true)
    // Still one live registration — value keeps redacting.
    expect(registry.isRegistered(SECRET)).toBe(true)
    expect(new Redactor(registry).redactText(SECRET)).toBe(REDACTED)

    expect(registry.unregister(h2)).toBe(true)
    expect(registry.isRegistered(SECRET)).toBe(false)
    expect(registry.size).toBe(0)
  })

  it('unregisters by value too', () => {
    const registry = new SecretRegistry()
    registry.register(SECRET)
    expect(registry.unregister(SECRET)).toBe(true)
    expect(registry.isRegistered(SECRET)).toBe(false)
    expect(registry.unregister(SECRET)).toBe(false)
  })

  it('binds secrets for the duration of a context and releases them', () => {
    const registry = new SecretRegistry()
    const release = registry.bound(SECRET, 'anotherlongsecret')
    const redactor = new Redactor(registry)
    expect(redactor.redactText(SECRET)).toBe(REDACTED)
    expect(redactor.redactText('anotherlongsecret')).toBe(REDACTED)

    release()
    expect(registry.isRegistered(SECRET)).toBe(false)
    expect(registry.isRegistered('anotherlongsecret')).toBe(false)
    expect(registry.size).toBe(0)
  })

  it('purges every secret and invalidates handles (zeroize on shutdown)', () => {
    const registry = new SecretRegistry()
    const handle = registry.register(SECRET)
    registry.register('anotherlongsecret')
    registry.purge()
    expect(registry.size).toBe(0)
    expect(registry.liveSecrets()).toEqual([])
    expect(registry.isRegistered(SECRET)).toBe(false)
    expect(registry.unregister(handle)).toBe(false)
    expect(new Redactor(registry).redactText(SECRET)).toBe(SECRET)
  })

  it('unregistering after expiry leaves no stale entry', () => {
    const registry = new SecretRegistry()
    const handle = registry.register(SECRET, { ttlMs: 30 })
    expect(registry.size).toBe(1)
    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(100)
      // Expiry is evaluated against the faked clock while it is still fake.
      registry.expireNow()
      expect(registry.size).toBe(0)
      expect(registry.isRegistered(SECRET)).toBe(false)
      expect(registry.unregister(handle)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lazily purges expired entries on the next register call', () => {
    const registry = new SecretRegistry()
    vi.useFakeTimers()
    try {
      registry.register(SECRET, { ttlMs: 30 })
      vi.advanceTimersByTime(100)
      registry.register('anotherlongsecret')
      expect(registry.size).toBe(1)
      expect(registry.isRegistered(SECRET)).toBe(false)
      expect(registry.isRegistered('anotherlongsecret')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SecretRegistry — TTL expiry boundary', () => {
  it('stops redacting a value after its TTL elapses (documented boundary)', () => {
    const registry = new SecretRegistry()
    registry.register(SECRET, { ttlMs: 25 })
    const redactor = new Redactor(registry)
    expect(redactor.redactText(`vault=${SECRET}`)).toBe(`vault=${REDACTED}`)

    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(100)
      registry.expireNow()
      // Post-expiry the value is a plain string again (documented boundary).
      expect(redactor.redactText(`vault=${SECRET}`)).toBe(`vault=${SECRET}`)
      expect(registry.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a non-expired value stays redacted until explicitly unregistered', () => {
    const registry = new SecretRegistry()
    const handle = registry.register(SECRET, { ttlMs: 60_000 })
    const redactor = new Redactor(registry)
    expect(redactor.redactText(SECRET)).toBe(REDACTED)
    registry.unregister(handle)
    expect(redactor.redactText(SECRET)).toBe(SECRET)
  })
})

describe('SecretRegistry — containment and concurrency', () => {
  it('is never serializable and never prints its contents', () => {
    const registry = new SecretRegistry()
    registry.register(SECRET)
    expect(String(registry)).toContain('registered=1')
    expect(String(registry)).not.toContain(SECRET)
    expect(() => JSON.stringify(registry)).toThrow(TypeError)
    expect(registry.liveSecrets().length).toBe(1)
  })

  it('liveSecrets returns a defensive copy', () => {
    const registry = new SecretRegistry()
    registry.register(SECRET)
    const copy = registry.liveSecrets()
    copy.length = 0
    expect(registry.isRegistered(SECRET)).toBe(true)
    expect(registry.size).toBe(1)
  })

  it('handles interleaved register/unregister without stale state', () => {
    const registry = new SecretRegistry()
    const a = registry.register(SECRET)
    const b = registry.register(SECRET)
    const c = registry.register('anotherlongsecret')
    registry.unregister(a)
    registry.unregister(c)
    // b still holds SECRET.
    expect(registry.isRegistered(SECRET)).toBe(true)
    registry.unregister(b)
    expect(registry.size).toBe(0)
    expect(registry.liveSecrets()).toEqual([])
  })

  it('concurrent async registration storms settle to a consistent count', async () => {
    const registry = new SecretRegistry()
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() => registry.register(i % 2 === 0 ? SECRET : 'anotherlongsecret'))
      )
    )
    expect(registry.size).toBe(2)
    // Unregister everything in reverse order.
    for (let i = 0; i < 20; i++) registry.unregister(i % 2 === 0 ? SECRET : 'anotherlongsecret')
    expect(registry.size).toBe(0)
  })

  it('registered secrets feed the redactor through the shared singleton', () => {
    const previous = secretRegistry.liveSecrets()
    const marker = 'singleton-secret-abcdef'
    const handle = secretRegistry.register(marker)
    try {
      expect(new Redactor(secretRegistry).redactText(`x ${marker} y`)).toBe(`x ${REDACTED} y`)
    } finally {
      secretRegistry.unregister(handle)
    }
    expect(secretRegistry.liveSecrets()).toEqual(previous)
  })
})
