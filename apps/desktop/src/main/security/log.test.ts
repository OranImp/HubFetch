/**
 * TDD suite for the RedactedLogger used by every main-process log site
 * (plan Todo 22). Guarantees NO unredacted secret reaches the console.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REDACTED } from './redaction'
import { secretRegistry } from './secret-registry'
import { RedactedLogger } from './log'

const SENTINEL = 'hf_AbCdEf0123456789AbCdEf0123456789'

describe('RedactedLogger', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('redacts the message and every detail argument before console.warn', () => {
    const logger = new RedactedLogger()
    logger.warn('auth', `sign in failed with ${SENTINEL}`, { token: SENTINEL }, new Error(SENTINEL))
    const calls = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]))
    for (const rendered of calls) {
      expect(rendered).not.toContain(SENTINEL)
      expect(rendered).toContain(REDACTED)
    }
  })

  it('redacts through the shared registry', () => {
    const registry = secretRegistry
    const marker = 'logger-singleton-secret-abc'
    const handle = registry.register(marker)
    try {
      const logger = new RedactedLogger()
      logger.warn('scope', `value ${marker} visible`)
      const rendered = String(warnSpy.mock.calls[0][0])
      expect(rendered).not.toContain(marker)
      expect(rendered).toContain(REDACTED)
    } finally {
      registry.unregister(handle)
    }
  })

  it('redacts Error objects including their cause chains', () => {
    const logger = new RedactedLogger()
    const root = new Error(`socket ${SENTINEL} unreachable`)
    const top = new Error('download failed')
    ;(top as { cause?: unknown }).cause = root
    logger.error('downloads', 'worker crashed', top)
    const prefix = String(errorSpy.mock.calls[0][0])
    const rendered = String(errorSpy.mock.calls[0][1])
    expect(prefix).toContain('worker crashed')
    expect(prefix).not.toContain(SENTINEL)
    expect(rendered).not.toContain(SENTINEL)
    expect(rendered).toContain('download failed')
    expect(rendered).toContain(REDACTED)
  })

  it('never throws on exotic detail arguments', () => {
    const logger = new RedactedLogger()
    expect(() =>
      logger.warn('scope', 'mixed payload', undefined, null, 42, Buffer.from([0xff]), {
        cyclic: undefined
      })
    ).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('prefixes the scope and keeps the call single-line safe', () => {
    const logger = new RedactedLogger()
    logger.warn('auth', `token ${SENTINEL} rejected`)
    const rendered = String(warnSpy.mock.calls[0][0])
    expect(rendered).toContain('[auth]')
  })
})
