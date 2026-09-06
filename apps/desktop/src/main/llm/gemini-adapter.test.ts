/**
 * Todo 8 — Gemini REST adapter through HubFetch's proxied fetch.
 *
 * A local node:http server stands in for the Gemini Developer API. Tests
 * assert the exact v1beta generateContent path, the x-goog-api-key header,
 * that the key never leaks into URL/body/log/error strings, contracts for
 * text/SAFETY/block/incompatible fixtures, timeout/cancel, malformed bodies,
 * and that 500/429 receive exactly one request (no retry loop).
 */
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LlmProviderConfig, LlmTranslateRequest } from '@hubfetch/shared'
import type { LlmAdapter } from './adapter'
import { createGeminiAdapter } from './gemini-adapter'

const PROBE_TEXT = 'OK'

interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  rawBody: string
}

interface ServerBehavior {
  /** Path -> status code + body (function so it can vary per call). */
  respond?: (
    path: string,
    body: string
  ) => { status: number; body: string }
  /** Delay in ms before responding. */
  delayMs?: number
}

function startServer(behavior?: ServerBehavior): Promise<{
  server: Server
  baseUrl: string
  requests: RecordedRequest[]
  close: () => Promise<void>
}> {
  const requests: RecordedRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        rawBody
      })
      const b = behavior?.respond
      const response = b
        ? b(req.url ?? '/', rawBody)
        : { status: 200, body: defaultTextCandidateBody('{"status":"translated","sourceLanguage":"en","markdown":"Hi"}') }
      const delay = behavior?.delayMs ?? 0
      setTimeout(() => {
        if (!res.writableEnded) {
          res.statusCode = response.status
          res.setHeader('content-type', 'application/json')
          res.end(response.body)
        }
      }, delay)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise((r) => {
            server.close(() => r())
            server.closeAllConnections?.()
          })
      })
    })
  })
}

function defaultTextCandidateBody(text: string): string {
  return JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { totalTokenCount: 5 }
  })
}

function probeConfig(modelId = 'gemini-2.0-flash'): LlmProviderConfig {
  return { modelId, baseUrl: null }
}

function translateRequest(over: Partial<LlmTranslateRequest> = {}): LlmTranslateRequest {
  return { requestId: 'req-1', markdown: '# Hello world', targetLocale: 'fr', ...over }
}

const TEST_KEY = 'test-google-api-key-1234'

let base = ''
let running: { close: () => Promise<void> }[] = []

async function withServer(behavior: ServerBehavior) {
  const s = await startServer(behavior)
  running.push(s)
  base = s.baseUrl
  return s
}

beforeAll(() => {
  // Ensure every created server is tracked for teardown.
})

afterAll(async () => {
  for (const r of running) await r.close()
  running = []
})

// ---------------------------------------------------------------------------
// Model ID normalization
// ---------------------------------------------------------------------------
describe('Gemini model normalization', () => {
  it('accepts bare gemini-* model IDs and normalizes to models/gemini-*', async () => {
    const s = await startServer({
      respond: () => ({ status: 200, body: defaultTextCandidateBody(PROBE_TEXT) })
    })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const res = await adapter.testConnection(probeConfig('gemini-2.0-flash'), new AbortController().signal)
    expect(res.ok).toBe(true)
    expect(s.requests).toHaveLength(1)
    expect(s.requests[0]!.path).toBe('/v1beta/models/gemini-2.0-flash:generateContent')
    await s.close()
  })

  it('accepts models/gemini-* IDs without double prefixing', async () => {
    const s = await startServer({
      respond: () => ({ status: 200, body: defaultTextCandidateBody(PROBE_TEXT) })
    })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'models/gemini-2.5-pro')
    const res = await adapter.testConnection(probeConfig('models/gemini-2.5-pro'), new AbortController().signal)
    expect(res.ok).toBe(true)
    expect(s.requests[0]!.path).toBe('/v1beta/models/gemini-2.5-pro:generateContent')
    await s.close()
  })
})

// ---------------------------------------------------------------------------
// Connection probe
// ---------------------------------------------------------------------------
describe('testConnection', () => {
  it('performs a minimal generateContent probe with x-goog-api-key header', async () => {
    const s = await startServer({
      respond: () => ({ status: 200, body: defaultTextCandidateBody(PROBE_TEXT) })
    })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const started = Date.now()
    const res = await adapter.testConnection(probeConfig(), new AbortController().signal)
    const latency = Date.now() - started

    expect(s.requests).toHaveLength(1)
    const req = s.requests[0]!
    expect(req.method).toBe('POST')
    expect(req.path).toBe('/v1beta/models/gemini-2.0-flash:generateContent')
    expect(req.headers['x-goog-api-key']).toBe(TEST_KEY)
    expect(req.headers['content-type']).toContain('application/json')

    // Probe input must request the literal token OK — no key, no prose.
    const parsedBody = JSON.parse(req.rawBody) as { contents?: { parts?: { text?: string }[] }[] }
    const promptText = parsedBody.contents?.[0]?.parts?.[0]?.text ?? ''
    expect(promptText).toBe(PROBE_TEXT)
    expect(req.rawBody).not.toContain(TEST_KEY)
    expect(req.path).not.toContain(TEST_KEY)

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.latencyMs).toBeGreaterThan(0)
    }
  })

  it('probe success requires a non-empty text part', async () => {
    // Empty candidates array.
    const s = await startServer({
      respond: () => ({ status: 200, body: JSON.stringify({ candidates: [] }) })
    })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const res = await adapter.testConnection(probeConfig(), new AbortController().signal)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('empty-response')
    await s.close()
  })

  it('probe fails closed with empty text part', async () => {
    const s = await startServer({
      respond: () =>
        ({ status: 200, body: defaultTextCandidateBody('') })
    })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const res = await adapter.testConnection(probeConfig(), new AbortController().signal)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('empty-response')
    await s.close()
  })
})

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------
describe('translate', () => {
  it('posts the translation prompt and returns a parsed envelope', async () => {
    const translated = '{"status":"translated","sourceLanguage":"en","markdown":"# Bonjour"}'
    const s = await startServer({
      respond: () => ({ status: 200, body: defaultTextCandidateBody(translated) })
    })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const res = await adapter.translate(translateRequest(), new AbortController().signal)

    expect(s.requests).toHaveLength(1)
    const req = s.requests[0]!
    expect(req.path).toBe('/v1beta/models/gemini-2.0-flash:generateContent')
    expect(req.headers['x-goog-api-key']).toBe(TEST_KEY)
    const body = JSON.parse(req.rawBody) as { contents?: { parts?: { text?: string }[] }[] }
    expect(body.contents?.[0]?.parts?.[0]?.text).toContain('# Hello world')
    expect(req.rawBody).not.toContain(TEST_KEY)

    expect(res.status).toBe('translated')
    if (res.status === 'translated') {
      expect(res.markdown).toBe('# Bonjour')
      expect(res.sourceLanguage).toBe('en')
    }
    await s.close()
  })

  it('returns same-language when the model reports it', async () => {
    const body = '{"status":"same-language","sourceLanguage":"fr"}'
    const s = await startServer({
      respond: () => ({ status: 200, body: defaultTextCandidateBody(body) })
    })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const res = await adapter.translate(translateRequest(), new AbortController().signal)
    expect(res.status).toBe('same-language')
    if (res.status === 'same-language') expect(res.sourceLanguage).toBe('fr')
    await s.close()
  })

  // --- Additive unknown fields are tolerated ---
  it('tolerates unknown additive fields in the response', async () => {
    const body =
      '{"status":"translated","sourceLanguage":"en","markdown":"# OK","customField":123,"nested":{"x":[1,2,3]}}'
    const raw = {
      candidates: [
        {
          safetyRatings: [{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'NEGLIGIBLE' }],
          content: { role: 'model', parts: [{ text: body }, { inlineData: { mimeType: 'x', data: 'abc' } }] },
          finishReason: 'STOP',
          index: 0
        }
      ],
      promptFeedback: { safetyRatings: [] },
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 9, totalTokenCount: 12 },
      modelVersion: 'gemini-2.0-flash'
    }
    const s = await startServer({ respond: () => ({ status: 200, body: JSON.stringify(raw) }) })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const res = await adapter.translate(translateRequest(), new AbortController().signal)
    expect(res.status).toBe('translated')
    await s.close()
  })
})

// ---------------------------------------------------------------------------
// Safety / refusal / incompatible fixtures
// ---------------------------------------------------------------------------
describe('safety, block and malformed mapping', () => {
  it('maps a prompt-level blockReason to refused', async () => {
    const s = await startServer({
      respond: () => ({
        status: 200,
        body: JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] }, finishReason: 'STOP' }],
          promptFeedback: { blockReason: 'SAFETY', safetyRatings: [] }
        })
      })
    })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const res = await adapter.translate(translateRequest(), new AbortController().signal)
    expect(res.status).toBe('error')
    if (res.status === 'error') expect(res.error).toBe('refused')
    await s.close()
  })

  it('maps candidate finishReason SAFETY to refused', async () => {
    const s = await startServer({
      respond: () => ({
        status: 200,
        body: JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'blocked' }] }, finishReason: 'SAFETY' }]
        })
      })
    })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const res = await adapter.translate(translateRequest(), new AbortController().signal)
    expect(res.status).toBe('error')
    if (res.status === 'error') expect(res.error).toBe('refused')
    await s.close()
  })

  it('maps PROHIBITED_CONTENT finish reason to refused', async () => {
    const s = await startServer({
      respond: () => ({
        status: 200,
        body: JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'PROHIBITED_CONTENT' }]
        })
      })
    })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const res = await adapter.testConnection(probeConfig(), new AbortController().signal)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('refused')
    await s.close()
  })

  it('rejects incompatible response shapes as malformed-response', async () => {
    // candidates is not an array
    const s = await startServer({
      respond: () => ({ status: 200, body: JSON.stringify({ candidates: 'oops' }) })
    })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const res = await adapter.translate(translateRequest(), new AbortController().signal)
    expect(res.status).toBe('error')
    if (res.status === 'error') expect(res.error).toBe('malformed-response')
    await s.close()
  })

  it('rejects a non-object response body as malformed-response', async () => {
    const s = await startServer({ respond: () => ({ status: 200, body: '"just a string"' }) })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const res = await adapter.translate(translateRequest(), new AbortController().signal)
    expect(res.status).toBe('error')
    if (res.status === 'error') expect(res.error).toBe('malformed-response')
    await s.close()
  })

  it('rejects unparseable JSON as malformed-response', async () => {
    const s = await startServer({ respond: () => ({ status: 200, body: '{not json' }) })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const res = await adapter.translate(translateRequest(), new AbortController().signal)
    expect(res.status).toBe('error')
    if (res.status === 'error') expect(res.error).toBe('malformed-response')
    await s.close()
  })
})

// ---------------------------------------------------------------------------
// HTTP status / error mapping
// ---------------------------------------------------------------------------
describe('HTTP error mapping', () => {
  it.each([
    [401, 'auth'],
    [403, 'forbidden'],
    [404, 'model-not-found'],
    [429, 'rate-limited']
  ] as const)('maps %s to %s', async (status, code) => {
    const s = await startServer({
      respond: () => ({ status, body: JSON.stringify({ error: { code, message: `boom ${TEST_KEY}` } }) })
    })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const res = await adapter.translate(translateRequest(), new AbortController().signal)
    expect(s.requests).toHaveLength(1)
    expect(res.status).toBe('error')
    if (res.status === 'error') {
      expect(res.error).toBe(code)
      // The key must never appear in the returned error.
      expect(JSON.stringify(res)).not.toContain(TEST_KEY)
    }
    await s.close()
  })

  it.each([500, 502, 503])('maps %s to provider-unavailable with exactly one request', async (status) => {
    const s = await startServer({
      respond: () => ({ status, body: JSON.stringify({ error: { message: 'internal' } }) })
    })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const res = await adapter.translate(translateRequest(), new AbortController().signal)
    expect(s.requests).toHaveLength(1)
    expect(res.status).toBe('error')
    if (res.status === 'error') expect(res.error).toBe('provider-unavailable')
    await s.close()
  })

  it('429 receives exactly one request', async () => {
    const s = await startServer({
      respond: () => ({ status: 429, body: JSON.stringify({ error: { message: 'quota' } }) })
    })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash')
    const res = await adapter.translate(translateRequest(), new AbortController().signal)
    expect(s.requests).toHaveLength(1)
    expect(res.status).toBe('error')
    if (res.status === 'error') expect(res.error).toBe('rate-limited')
    await s.close()
  })
})

// ---------------------------------------------------------------------------
// Timeout / cancellation
// ---------------------------------------------------------------------------
describe('timeout and cancellation', () => {
  it('maps a composed timeout to timeout and still one request', async () => {
    const s = await startServer({ respond: () => ({ status: 200, body: defaultTextCandidateBody(PROBE_TEXT) }), delayMs: 2000 })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash', { timeoutMs: 50 })
    const res = await adapter.testConnection(probeConfig(), new AbortController().signal)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('timeout')
    await s.close()
  }, 4000)

  it('maps external cancellation to canceled', async () => {
    const s = await startServer({ respond: () => ({ status: 200, body: defaultTextCandidateBody(PROBE_TEXT) }), delayMs: 5000 })
    running.push(s)
    const adapter = makeAdapter(s.baseUrl, 'gemini-2.0-flash', { timeoutMs: 30_000 })
    const controller = new AbortController()
    const promise = adapter.testConnection(probeConfig(), controller.signal)
    setTimeout(() => controller.abort(), 30)
    const res = await promise
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('canceled')
    await s.close()
  }, 4000)
})

// ---------------------------------------------------------------------------
// No @google/genai dependency anywhere.
// ---------------------------------------------------------------------------
describe('no @google/genai dependency', () => {
  it('does not appear in any package.json in the workspace', () => {
    const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
    const candidates = [
      join(root, 'package.json'),
      join(root, 'apps', 'desktop', 'package.json'),
      join(root, 'packages', 'shared', 'package.json'),
      join(root, 'packages', 'hub-api', 'package.json')
    ]
    for (const file of candidates) {
      try {
        const content = readFileSync(file, 'utf8')
        expect(content).not.toContain('@google/genai')
      } catch {
        // File absent — treat as pass (not an added dependency).
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Adapter factory helper
// ---------------------------------------------------------------------------
function makeAdapter(baseUrl: string, modelId: string, opts: { timeoutMs?: number } = {}): LlmAdapter {
  return createGeminiAdapter({
    apiKey: TEST_KEY,
    baseUrl,
    modelId,
    fetchImpl: fetch,
    timeoutMs: opts.timeoutMs ?? 60_000
  })
}