/**
 * QA happy path (plan Todo 22): register a random NON-pattern sentinel, emit it
 * through every supported structure (text, nested objects, arrays, keys, URL
 * userinfo/query, header lines, cookie objects, exception cause chains,
 * buffers, and the logger), and assert only `[REDACTED]` appears — never the
 * sentinel. Prints [qa-happy] evidence lines for qa-happy.txt.
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Redactor, REDACTED } from './security/redaction'
import { SecretRegistry } from './security/secret-registry'
import { RedactedLogger } from './security/log'

/** Non-pattern random sentinel — nothing but exact-value registration redacts it. */
const SENTINEL = randomBytes(16).toString('hex')
const needle = Buffer.from(SENTINEL, 'utf8')

function expectNoSentinel(artifact: string): void {
  expect(Buffer.from(artifact, 'utf8').includes(needle)).toBe(false)
}

describe('QA happy — registered random sentinel redacts everywhere', () => {
  it('register a random non-pattern sentinel and emit it through every structure', () => {
    const registry = new SecretRegistry()
    const handle = registry.register(SENTINEL)
    const redactor = new Redactor(registry)
    // The logger must use THIS redactor (same registry), not the process-wide
    // default, so the random sentinel is value-redacted at the console seam.
    const logger = new RedactedLogger(redactor)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const artifacts: Record<string, string> = {}
    try {
      // 1. Plain text.
      const text = `vault value ${SENTINEL} cached at rest`
      artifacts['text'] = redactor.redactText(text)

      // 2. URL userinfo + sensitive query.
      artifacts['url'] = redactor.redactText(
        `https://alice:${SENTINEL}@example.com:8443/api?access_token=${SENTINEL}&tab=1`
      )

      // 3. Header line + cookie object.
      artifacts['header'] = redactor.redactText(`Authorization: Bearer ${SENTINEL}`)
      const structured = redactor.redactValue({
        headers: { authorization: `Bearer ${SENTINEL}`, 'x-custom-id': 'abc' },
        cookies: { session: SENTINEL }
      }) as Record<string, Record<string, unknown>>
      artifacts['structured'] = JSON.stringify(structured)

      // 4. Registered secret in an object KEY.
      artifacts['key'] = JSON.stringify(
        redactor.redactValue({ [SENTINEL]: 'value' } as Record<string, unknown>)
      )

      // 5. Nested object + array + numbers.
      artifacts['nested'] = JSON.stringify(
        redactor.redactValue({
          deep: { list: [1, SENTINEL, { token: SENTINEL }], label: 'keep' }
        })
      )

      // 6. Exception cause chain.
      const root = new Error(`socket ${SENTINEL} unreachable`)
      const mid = new Error('api failed')
      ;(mid as { cause?: unknown }).cause = root
      artifacts['error'] = redactor.redactError(mid)

      // 7. UTF-8 buffer payload.
      artifacts['buffer'] = String(redactor.redactValue(Buffer.from(`key=${SENTINEL}`)))

      // 8. The logger (main-process console seam).
      logger.warn('qa', 'credential rejected', { token: SENTINEL }, new Error(SENTINEL))
      artifacts['logger'] = warnSpy.mock.calls
        .map((call) => call.map((arg) => String(arg)).join(' | '))
        .join('\n')

      // Every artifact: sentinel absent, and where a secret sat, only REDACTED.
      for (const [label, artifact] of Object.entries(artifacts)) {
        console.log(`[qa-happy] ${label}: ${artifact}`)
        expectNoSentinel(artifact)
      }
      console.log(`[qa-happy] sentinel: ${SENTINEL}`)
      expect(artifacts.text).toBe(`vault value ${REDACTED} cached at rest`)
      expect(artifacts.url).toBe(
        `https://${REDACTED}@example.com:8443/api?access_token=${REDACTED}&tab=1`
      )
      expect(artifacts.header).toBe(`Authorization: ${REDACTED}`)
      const structuredHeaders = structured.headers as Record<string, unknown>
      expect(structuredHeaders.authorization).toBe(REDACTED)
      expect(artifacts.key).not.toContain(SENTINEL)
    } finally {
      registry.unregister(handle)
      warnSpy.mockRestore()
    }
    console.log('[qa-happy] registry size after unregister:', registry.size)
    expect(registry.size).toBe(0)
  })
})
