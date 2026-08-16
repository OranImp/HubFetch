/**
 * QA failure path (plan Todo 22): prove the documented registry boundaries.
 * 1) A deliberately UNREGISTERED short value (below the minimum useful length)
 *    is rejected at registration and passes through redaction untouched.
 * 2) A value past its TTL expiry is no longer redacted — the registry holds no
 *    stale entry afterwards. Prints [qa-failure] evidence lines.
 */
import { describe, expect, it, vi } from 'vitest'
import { Redactor, REDACTED, RedactionError } from './security/redaction'
import { DEFAULT_MIN_SECRET_LENGTH, SecretRegistry } from './security/secret-registry'

describe('QA failure — documented registry boundaries', () => {
  it('a too-short value cannot be registered and is not value-redacted', () => {
    const registry = new SecretRegistry()
    const short = 'abcde' // 5 chars < minimum useful length
    console.log(
      `[qa-failure] min length: ${registry.minLength} (default ${DEFAULT_MIN_SECRET_LENGTH})`
    )
    console.log(`[qa-failure] short value: ${short} (length ${short.length})`)

    let rejected = false
    try {
      registry.register(short)
    } catch (err) {
      rejected = err instanceof RedactionError
    }
    console.log(`[qa-failure] register rejected: ${rejected}`)
    expect(rejected).toBe(true)

    const redactor = new Redactor(registry)
    const out = redactor.redactText(`sentinel-ish value ${short} passes through`)
    console.log(`[qa-failure] short value survives redaction: ${out}`)
    // Documented boundary: below the minimum useful length a value is not
    // registered, so exact-value redaction does not apply.
    expect(out).toContain(short)
    expect(registry.size).toBe(0)
  })

  it('a post-expiry value is no longer redacted and leaves no stale entry', () => {
    const registry = new SecretRegistry()
    const secret = 'expiry-secret-value-abcdef'
    const handle = registry.register(secret, { ttlMs: 20 })
    const redactor = new Redactor(registry)
    const before = redactor.redactText(`vault=${secret}`)
    console.log(`[qa-failure] within TTL: ${before}`)
    expect(before).toBe(`vault=${REDACTED}`)

    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(100)
      registry.expireNow()
    } finally {
      vi.useRealTimers()
    }

    const after = redactor.redactText(`vault=${secret}`)
    console.log(`[qa-failure] post-expiry: ${after}`)
    // Documented boundary: a registration self-expires; the value is a plain
    // string again and must be re-registered to redact.
    expect(after).toBe(`vault=${secret}`)
    console.log(`[qa-failure] registry size after expiry: ${registry.size}`)
    expect(registry.size).toBe(0)
    expect(registry.liveSecrets()).toEqual([])
    expect(registry.unregister(handle)).toBe(false)
  })
})
