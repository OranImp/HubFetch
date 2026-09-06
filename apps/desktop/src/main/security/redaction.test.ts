/**
 * TDD suite for the centralized redactor (plan Todo 22).
 *
 * Ports the archived Python redaction semantics to TypeScript and adds the
 * bounds the plan requires: cycles, depth/string/output caps, binary payloads,
 * and immutability. Written FIRST (red phase) — every case in this file must
 * pass against the implementation in `./redaction`.
 */
import { describe, expect, it } from 'vitest'
import { Redactor, REDACTED, RedactionError } from './redaction'
import { SecretRegistry } from './secret-registry'

const SENTINEL = 'hf_AbCdEf0123456789AbCdEf0123456789'

describe('Redactor.redactText — URLs', () => {
  it('redacts URL userinfo while preserving host and path', () => {
    const out = new Redactor().redactText(
      `fetching https://alice:${SENTINEL}@example.com/releases now`
    )
    expect(out).not.toContain(SENTINEL)
    expect(out).toContain(`${REDACTED}@example.com/releases`)
  })

  it('preserves the port of a userinfo URL', () => {
    const out = new Redactor().redactText('https://alice:pass@example.com:8443/private?tab=1')
    expect(out).toContain(`${REDACTED}@example.com:8443/private`)
    expect(out).toContain('tab=1')
  })

  it('redacts only the value of a sensitive query parameter', () => {
    const out = new Redactor().redactText(`https://example.com/api?access_token=${SENTINEL}&page=2`)
    expect(out).not.toContain(SENTINEL)
    expect(out).toContain(`access_token=${REDACTED}`)
    expect(out).toContain('page=2')
  })

  it('leaves non-sensitive query pairs untouched', () => {
    const out = new Redactor().redactText('https://example.com/x?q=hf_notoken&limit=5')
    expect(out).toContain('q=hf_notoken')
    expect(out).toContain('limit=5')
  })
})

describe('Redactor.redactText — headers, cookies, credentials', () => {
  it('redacts an Authorization header line by name', () => {
    const out = new Redactor().redactText(`Authorization: Bearer ${SENTINEL}`)
    expect(out).not.toContain(SENTINEL)
    expect(out).toContain('Authorization: [REDACTED]')
  })

  it('redacts a Cookie header line by name', () => {
    const out = new Redactor().redactText(`Cookie: session=${SENTINEL}; theme=dark`)
    expect(out).not.toContain(SENTINEL)
    expect(out).toContain('Cookie: [REDACTED]')
  })

  it('redacts Bearer tokens in free text without a header name', () => {
    const out = new Redactor().redactText(`granted bearer ${SENTINEL} to the caller`)
    expect(out).not.toContain(SENTINEL)
    expect(out).toContain('granted bearer [REDACTED] to the caller')
  })

  it('redacts Basic base64 credentials in free text', () => {
    const b64 = Buffer.from('alice:hunter2secret').toString('base64')
    const out = new Redactor().redactText(`proxy auth Basic ${b64} accepted`)
    expect(out).not.toContain(b64)
    expect(out).toContain('proxy auth Basic [REDACTED] accepted')
  })

  it('redacts Git credential-protocol alias and password lines', () => {
    const out = new Redactor().redactText(
      `username=alice\npassword=hf_test_secret_123\nprotocol=https\n`
    )
    expect(out).not.toContain('hf_test_secret_123')
    expect(out).toContain('username=[REDACTED]')
    expect(out).toContain('password=[REDACTED]')
    expect(out).toContain('protocol=https')
  })

  it('redacts AskPass prompt responses', () => {
    const out = new Redactor().redactText(`Password for 'https://alice@example.com': ${SENTINEL}`)
    expect(out).not.toContain(SENTINEL)
    expect(out).toContain('Password for')
    expect(out).toContain(`${REDACTED}@example.com`)
    expect(out.endsWith(REDACTED)).toBe(true)
  })
})

describe('Redactor.redactText — Hugging Face patterns', () => {
  it('redacts access and organization token patterns', () => {
    const text =
      'token hf_AbCdEf0123456789AbCdEf0123456789 ' +
      'and org api_org_AbCdEf0123456789AbCdEf0123456789'
    const out = new Redactor().redactText(text)
    expect(out).not.toContain('hf_AbCdEf0123456789AbCdEf0123456789')
    expect(out).not.toContain('api_org_AbCdEf0123456789AbCdEf0123456789')
    expect(out.split(REDACTED).length - 1).toBe(2)
  })

  it('does not rely on hf_ patterns alone — unregistered values pass through', () => {
    // A non-HF secret that is NOT registered must survive (documented boundary);
    // structural rules still apply. Regression guard against over-redaction.
    const out = new Redactor().redactText('plain word hunter2secret passes through')
    expect(out).toContain('hunter2secret')
  })
})

describe('Redactor.redactText — registered secrets', () => {
  it('redacts a registered secret by exact value', () => {
    const registry = new SecretRegistry()
    registry.register(SENTINEL)
    const out = new Redactor(registry).redactText(`credential ${SENTINEL} cached`)
    expect(out).not.toContain(SENTINEL)
    expect(out).toBe(`credential ${REDACTED} cached`)
  })

  it('redacts overlapping registered secrets longest-first', () => {
    const registry = new SecretRegistry()
    registry.register(SENTINEL)
    registry.register('AbCdEf0123456789AbCdEf')
    const out = new Redactor(registry).redactText(`vault=${SENTINEL}`)
    expect(out).not.toContain(SENTINEL)
    expect(out).not.toContain('AbCdEf0123456789AbCdEf')
    expect(out).toBe(`vault=${REDACTED}`)
  })

  it('handles Unicode and newline-bearing registered secrets', () => {
    const registry = new SecretRegistry()
    const unicode = 'sècrêt-✓-value'
    registry.register(unicode)
    registry.register('multi\nline\nsecret')
    const out = new Redactor(registry).redactText(`a=${unicode} b=multi\nline\nsecret!`)
    expect(out).not.toContain(unicode)
    expect(out).not.toContain('multi\nline\nsecret')
    expect(out).toBe(`a=${REDACTED} b=${REDACTED}!`)
  })
})

describe('Redactor.redactValue — structure', () => {
  it('recurses over nested JSON values and redacts sensitive field names', () => {
    const out = new Redactor().redactValue({
      token: SENTINEL,
      nested: { secret: SENTINEL, keep: 'ok' },
      ports: [1, 2]
    }) as Record<string, unknown>
    expect(out.token).toBe(REDACTED)
    expect((out.nested as Record<string, unknown>).secret).toBe(REDACTED)
    expect((out.nested as Record<string, unknown>).keep).toBe('ok')
    expect(out.ports).toEqual([1, 2])
    expect(JSON.stringify(out)).not.toContain(SENTINEL)
  })

  it('redacts structured header and cookie objects by key name', () => {
    const out = new Redactor().redactValue({
      headers: { authorization: `Bearer ${SENTINEL}`, 'x-custom-id': 'abc123' },
      cookies: { token: SENTINEL }
    }) as Record<string, Record<string, unknown>>
    const headers = out.headers as Record<string, unknown>
    const cookies = out.cookies as Record<string, unknown>
    expect(headers.authorization).toBe(REDACTED)
    expect(headers['x-custom-id']).toBe('abc123')
    expect(cookies.token).toBe(REDACTED)
  })

  it('preserves closed public Hub capability keys while redacting nearby secrets', () => {
    const out = new Redactor().redactValue({
      key: 'searchRepos',
      token: SENTINEL
    }) as Record<string, unknown>
    expect(out.key).toBe('searchRepos')
    expect(out.token).toBe(REDACTED)
  })

  it('redacts any whole field literally named cookie', () => {
    const out = new Redactor().redactValue({
      cookie: `session=${SENTINEL}`,
      'set-cookie': `id=${SENTINEL}`
    }) as Record<string, unknown>
    expect(out.cookie).toBe(REDACTED)
    expect(out['set-cookie']).toBe(REDACTED)
  })

  it('redacts URL-bearing values structurally inside objects', () => {
    const out = new Redactor().redactValue({
      url: `https://alice:${SENTINEL}@example.com/x?token=${SENTINEL}&tab=1`
    }) as Record<string, string>
    expect(out.url).toBe(`https://${REDACTED}@example.com/x?token=${REDACTED}&tab=1`)
  })

  it('does not mutate the caller object (immutability, deep-frozen input)', () => {
    const input: Record<string, unknown> = {
      token: SENTINEL,
      nested: { list: ['a', SENTINEL, 'b'] }
    }
    Object.freeze(input)
    Object.freeze(input.nested as Record<string, unknown>)
    Object.freeze((input.nested as Record<string, unknown>).list as unknown[])
    const out = new Redactor().redactValue(input) as { nested: { list: unknown[] } }
    expect(out.nested.list).toEqual(['a', REDACTED, 'b'])
    expect((input.nested as { list: unknown[] }).list[1]).toBe(SENTINEL)
  })

  it('handles cycles explicitly instead of crashing', () => {
    const cyclic: Record<string, unknown> = { name: 'root' }
    cyclic.self = cyclic
    const out = new Redactor().redactValue(cyclic) as Record<string, unknown>
    expect(out.self).toBe('[Circular]')
    expect(out.name).toBe('root')
  })

  it('marks shared (non-cyclic) references distinctly from cycles when revisited in path', () => {
    // A true cycle is on the current path once; a repeated reference off-path
    // renders fully (path tracking). Only an on-path revisit is circular.
    const leaf: Record<string, unknown> = { token: SENTINEL }
    const parent: Record<string, unknown> = { a: leaf, b: leaf }
    const out = new Redactor().redactValue(parent) as Record<string, Record<string, unknown>>
    const a = out.a as Record<string, unknown>
    const b = out.b as Record<string, unknown>
    expect(a.token).toBe(REDACTED)
    expect(b.token).toBe(REDACTED)
  })

  it('bounds recursion depth with an explicit truncation marker', () => {
    let deep: Record<string, unknown> = { leaf: 'v' }
    for (let i = 0; i < 80; i++) deep = { child: deep }
    const out = new Redactor().redactValue(deep) as Record<string, unknown>
    // Walk the redacted chain: depth must stop at maxDepth with a marker.
    let cursor: unknown = out
    let depth = 0
    let sawMarker = false
    while (depth < 64) {
      if (cursor === '[Truncated]') {
        sawMarker = true
        break
      }
      if (typeof cursor !== 'object' || cursor === null) break
      cursor = (cursor as Record<string, unknown>).child
      depth += 1
    }
    expect(sawMarker).toBe(true)
    expect(depth).toBeLessThanOrEqual(16)
  })

  it('caps long strings in output', () => {
    const long = `prefix-${SENTINEL}-` + 'x'.repeat(10_000)
    const out = new Redactor().redactValue(long) as string
    expect(out).not.toContain(SENTINEL)
    expect(out.length).toBeLessThanOrEqual(4096)
  })

  it('redacts UTF-8 buffers and keeps opaque binary explicit', () => {
    const registry = new SecretRegistry()
    registry.register(SENTINEL)
    const redactor = new Redactor(registry)
    expect(redactor.redactValue(Buffer.from(`key=${SENTINEL}`))).toBe(`key=${REDACTED}`)
    expect(redactor.redactValue(Buffer.from([0xff, 0xfe, 0x00]))).toBe('[Binary 3 bytes]')
    expect(redactor.redactValue(new Uint8Array([0xff, 0x00]))).toBe('[Binary 2 bytes]')
  })

  it('normalizes non-JSON primitives without leaking secrets', () => {
    const redactor = new Redactor()
    const out = redactor.redactValue({
      at: new Date('2026-01-01T00:00:00Z'),
      big: 123456789012345678901234567890n,
      fn: () => 'source-with-secret',
      sym: Symbol('secret')
    }) as Record<string, unknown>
    expect(out.at).toBe('2026-01-01T00:00:00.000Z')
    expect(out.big).toBe('123456789012345678901234567890')
    expect(out.fn).toBe('[Function]')
    expect(out.sym).toBe('[Symbol]')
    expect(JSON.stringify(out)).not.toContain('source-with-secret')
  })
})

describe('Redactor.redactError — exception chains', () => {
  it('renders the cause chain with type context and redacted messages', () => {
    const registry = new SecretRegistry()
    registry.register(SENTINEL)
    const root = new Error(`socket peer ${SENTINEL} unreachable`)
    const middle = new Error('hub api call failed')
    ;(middle as { cause?: unknown }).cause = root
    const top = new Error('worker aborted')
    ;(top as { cause?: unknown }).cause = middle

    const rendered = new Redactor(registry).redactError(top)

    expect(rendered).not.toContain(SENTINEL)
    expect(rendered).toContain('Error: worker aborted')
    expect(rendered).toContain('hub api call failed')
    expect(rendered).toContain(REDACTED)
  })

  it('redacts a top-level error message alone for IPC flattening', () => {
    const out = new Redactor().redactErrorText(
      new Error(`GET https://alice:${SENTINEL}@example.com/x failed: 401`)
    )
    expect(out).not.toContain(SENTINEL)
    expect(out).toContain(`${REDACTED}@example.com`)
    expect(out).toContain('failed: 401')
  })

  it('never throws on non-Error values', () => {
    const redactor = new Redactor()
    expect(redactor.redactError('plain string')).toContain('plain string')
    expect(redactor.redactError(42)).toBeTruthy()
    expect(redactor.redactError(null)).toBeTruthy()
  })
})

describe('Redactor — determinism and sentinel-free output', () => {
  it('is deterministic for the same input', () => {
    const redactor = new Redactor()
    const text = `https://alice:${SENTINEL}@example.com/x?token=${SENTINEL}&tab=1`
    expect(redactor.redactText(text)).toBe(redactor.redactText(text))
  })

  it('produces artifacts free of sentinel bytes at every entry point', () => {
    const registry = new SecretRegistry()
    registry.register(SENTINEL)
    const redactor = new Redactor(registry)
    const artifacts = [
      redactor.redactText(`https://alice:${SENTINEL}@example.com?token=${SENTINEL}`),
      redactor.redactError(new Error(SENTINEL)),
      String(registry),
      JSON.stringify(redactor.redactValue({ token: SENTINEL, nested: { secret: SENTINEL } }))
    ]
    for (const artifact of artifacts) {
      expect(Buffer.from(artifact, 'utf8').includes(Buffer.from(SENTINEL, 'utf8'))).toBe(false)
    }
  })

  it('preserves non-secret diagnostics', () => {
    const text =
      'GET /api/v2/models/org/model HTTP/1.1\n' +
      'Host: huggingface.co\n' +
      'X-Custom-Id: abc123\n' +
      'Cache-Control: no-cache\n' +
      `Authorization: Bearer ${SENTINEL}\n`
    const out = new Redactor().redactText(text)
    expect(out).not.toContain(SENTINEL)
    expect(out).toContain('GET /api/v2/models/org/model HTTP/1.1')
    expect(out).toContain('Host: huggingface.co')
    expect(out).toContain('X-Custom-Id: abc123')
    expect(out).toContain('Authorization: [REDACTED]')
  })
})

describe('Redactor — bounds and error containment', () => {
  it('rejects registrations of empty secrets with a typed error', () => {
    const registry = new SecretRegistry()
    expect(() => registry.register('')).toThrow(RedactionError)
  })

  it('does not expose the registry through serialization', () => {
    const registry = new SecretRegistry()
    registry.register(SENTINEL)
    expect(String(registry)).toContain('registered=1')
    expect(String(registry)).not.toContain(SENTINEL)
    expect(() => JSON.stringify(registry)).toThrow(TypeError)
  })

  it('redacts registered secrets appearing in object keys (fuzz guarantee)', () => {
    const registry = new SecretRegistry()
    registry.register('random-sentinel-xyz-123')
    const out = new Redactor(registry).redactValue({
      'random-sentinel-xyz-123': 'value'
    }) as Record<string, unknown>
    expect(JSON.stringify(out)).not.toContain('random-sentinel-xyz-123')
  })
})
