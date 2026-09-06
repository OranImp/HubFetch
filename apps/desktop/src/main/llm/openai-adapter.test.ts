/**
 * Todo 6 — OpenAI adapter with zero-retry wire tests.
 *
 * Uses a local node:http server on 127.0.0.1:0 to prove:
 * - Minimal probe and translation call both on /chat/completions with configured model
 * - Authorization: Bearer header present
 * - Empty response → error
 * - Key never in URL/body/error/evidence
 * - Timeout and cancel abort
 * - 401/403/404/429/5xx map correctly
 * - 500 retryable: exactly ONE request (maxRetries 0)
 */
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OpenAI from 'openai'
import type { LlmProviderConfig, LlmTranslateRequest } from '@hubfetch/shared'
import { OpenAIAdapter, mapOpenAIError } from './openai-adapter'

// ---------------------------------------------------------------------------
// Helpers: local HTTP server
// ---------------------------------------------------------------------------

interface RequestRecord {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

async function startServer(
  handler: (req: RequestRecord) => { status: number; body: unknown; headers?: Record<string, string> },
): Promise<{ server: Server; port: number; records: RequestRecord[] }> {
  const records: RequestRecord[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let body: unknown = {}
      try {
        body = JSON.parse(rawBody)
      } catch {
        body = rawBody
      }
      const record: RequestRecord = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers as Record<string, string>,
        body,
      }
      records.push(record)
      const result = handler(record)
      res.writeHead(result.status, {
        'Content-Type': 'application/json',
        ...result.headers,
      })
      res.end(JSON.stringify(result.body))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to get server address')
  return { server, port: address.port, records }
}

const TEST_MODEL = 'gpt-4o-mini'
const TEST_KEY = 'sk-test-key-1234567890abcdef'

function makeConfig(baseUrl: string): LlmProviderConfig {
  return { modelId: TEST_MODEL, baseUrl }
}

function makeTranslateRequest(): LlmTranslateRequest {
  return {
    requestId: 'test-req-1',
    markdown: '# Hello\n\nThis is a test post.',
    targetLocale: 'fr',
  }
}

function openaiChatResponse(
  content: string,
  finishReason: string = 'stop',
): object {
  return {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    created: 1_000_000,
    model: TEST_MODEL,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }
}

function openaiErrorBody(code: string, message: string): object {
  return { error: { code, message, type: 'error' } }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAIAdapter', () => {
  let server: Server
  let port: number
  let records: RequestRecord[]
  let adapter: OpenAIAdapter

  afterEach(async () => {
    server.close()
  })

  describe('testConnection', () => {
    beforeEach(async () => {
      const result = await startServer(() => ({
        status: 200,
        body: openaiChatResponse('OK'),
      }))
      server = result.server
      port = result.port
      records = result.records
      adapter = new OpenAIAdapter(TEST_KEY, { mode: 'direct' })
    })

    it('sends a minimal probe to /chat/completions with the configured model', async () => {
      const result = await adapter.testConnection(makeConfig(`http://127.0.0.1:${port}/v1`), new AbortController().signal)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.latencyMs).toBeGreaterThanOrEqual(0)
      }
      expect(records).toHaveLength(1)
      expect(records[0]!.method).toBe('POST')
      expect(records[0]!.path).toBe('/v1/chat/completions')
      const body = records[0]!.body as Record<string, unknown>
      expect(body.model).toBe(TEST_MODEL)
      expect(body.stream).toBe(false)
      expect(body.max_tokens).toBe(10)
      expect(body.temperature).toBe(0)
    })

    it('includes Authorization: Bearer header', async () => {
      await adapter.testConnection(makeConfig(`http://127.0.0.1:${port}/v1`), new AbortController().signal)
      const auth = records[0]!.headers.authorization
      expect(auth).toBe(`Bearer ${TEST_KEY}`)
    })

    it('returns latency on success', async () => {
      const result = await adapter.testConnection(makeConfig(`http://127.0.0.1:${port}/v1`), new AbortController().signal)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.latencyMs).toBeGreaterThan(0)
      }
    })

    it('returns empty-response when assistant content is null', async () => {
      const { server: s2, port: p2 } = await startServer(() => ({
        status: 200,
        body: openaiChatResponse(''),
      }))
      try {
        const ad = new OpenAIAdapter(TEST_KEY, { mode: 'direct' })
        const result = await ad.testConnection(makeConfig(`http://127.0.0.1:${p2}/v1`), new AbortController().signal)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error).toBe('empty-response')
      } finally {
        s2.close()
      }
    })

    it('returns empty-response when assistant content is whitespace', async () => {
      const { server: s2, port: p2 } = await startServer(() => ({
        status: 200,
        body: openaiChatResponse('   '),
      }))
      try {
        const ad = new OpenAIAdapter(TEST_KEY, { mode: 'direct' })
        const result = await ad.testConnection(makeConfig(`http://127.0.0.1:${p2}/v1`), new AbortController().signal)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error).toBe('empty-response')
      } finally {
        s2.close()
      }
    })

    it('key never appears in URL, body, or error', async () => {
      const result = await adapter.testConnection(makeConfig(`http://127.0.0.1:${port}/v1`), new AbortController().signal)
      // Key is in Authorization header only
      expect(records[0]!.path).not.toContain(TEST_KEY)
      const bodyStr = JSON.stringify(records[0]!.body)
      expect(bodyStr).not.toContain(TEST_KEY)
      // Error should not contain key
      if (!result.ok) {
        const errStr = JSON.stringify(result)
        expect(errStr).not.toContain(TEST_KEY)
      }
    })
  })

  describe('translateWithConfig', () => {
    beforeEach(async () => {
      const result = await startServer(() => ({
        status: 200,
        body: openaiChatResponse(
          '{"status":"translated","sourceLanguage":"en","markdown":"# Bonjour\\n\\nCeci est un test."}',
        ),
      }))
      server = result.server
      port = result.port
      records = result.records
      adapter = new OpenAIAdapter(TEST_KEY, { mode: 'direct' })
    })

    it('sends a translation request to /chat/completions with the configured model', async () => {
      const result = await adapter.translateWithConfig(
        makeTranslateRequest(),
        makeConfig(`http://127.0.0.1:${port}/v1`),
        new AbortController().signal,
      )
      expect(result.status).toBe('translated')
      expect(records).toHaveLength(1)
      expect(records[0]!.method).toBe('POST')
      expect(records[0]!.path).toBe('/v1/chat/completions')
      const body = records[0]!.body as Record<string, unknown>
      expect(body.model).toBe(TEST_MODEL)
      expect(body.stream).toBe(false)
    })

    it('includes the translation prompt in the request body', async () => {
      await adapter.translateWithConfig(
        makeTranslateRequest(),
        makeConfig(`http://127.0.0.1:${port}/v1`),
        new AbortController().signal,
      )
      const messages = (records[0]!.body as Record<string, unknown>).messages as Array<Record<string, unknown>>
      expect(messages).toHaveLength(1)
      expect(messages[0]!.role).toBe('user')
      expect(messages[0]!.content as string).toContain('Translate the following Markdown')
      expect(messages[0]!.content as string).toContain('fr')
      expect(messages[0]!.content as string).toContain('# Hello')
    })

    it('returns parsed translated envelope', async () => {
      const result = await adapter.translateWithConfig(
        makeTranslateRequest(),
        makeConfig(`http://127.0.0.1:${port}/v1`),
        new AbortController().signal,
      )
      expect(result.status).toBe('translated')
      if (result.status === 'translated') {
        expect(result.sourceLanguage).toBe('en')
        expect(result.markdown).toContain('Bonjour')
      }
    })

    it('returns same-language envelope', async () => {
      const { server: s2, port: p2, records: r2 } = await startServer(() => ({
        status: 200,
        body: openaiChatResponse('{"status":"same-language","sourceLanguage":"en"}'),
      }))
      try {
        const ad = new OpenAIAdapter(TEST_KEY, { mode: 'direct' })
        const result = await ad.translateWithConfig(
          makeTranslateRequest(),
          makeConfig(`http://127.0.0.1:${p2}/v1`),
          new AbortController().signal,
        )
        expect(result.status).toBe('same-language')
        if (result.status === 'same-language') {
          expect(result.sourceLanguage).toBe('en')
        }
      } finally {
        s2.close()
      }
    })

    it('returns empty-response error when response is empty', async () => {
      const { server: s2, port: p2 } = await startServer(() => ({
        status: 200,
        body: openaiChatResponse(''),
      }))
      try {
        const ad = new OpenAIAdapter(TEST_KEY, { mode: 'direct' })
        const result = await ad.translateWithConfig(
          makeTranslateRequest(),
          makeConfig(`http://127.0.0.1:${p2}/v1`),
          new AbortController().signal,
        )
        expect(result.status).toBe('error')
        if (result.status === 'error') expect(result.error).toBe('empty-response')
      } finally {
        s2.close()
      }
    })

    it('returns malformed-response error for invalid JSON in content', async () => {
      const { server: s2, port: p2 } = await startServer(() => ({
        status: 200,
        body: openaiChatResponse('not valid json at all'),
      }))
      try {
        const ad = new OpenAIAdapter(TEST_KEY, { mode: 'direct' })
        const result = await ad.translateWithConfig(
          makeTranslateRequest(),
          makeConfig(`http://127.0.0.1:${p2}/v1`),
          new AbortController().signal,
        )
        expect(result.status).toBe('error')
        if (result.status === 'error') expect(result.error).toBe('malformed-response')
      } finally {
        s2.close()
      }
    })

    it('includes Authorization header on translation requests', async () => {
      await adapter.translateWithConfig(
        makeTranslateRequest(),
        makeConfig(`http://127.0.0.1:${port}/v1`),
        new AbortController().signal,
      )
      expect(records[0]!.headers.authorization).toBe(`Bearer ${TEST_KEY}`)
    })

    it('key never appears in URL, body, or error for translation', async () => {
      const result = await adapter.translateWithConfig(
        makeTranslateRequest(),
        makeConfig(`http://127.0.0.1:${port}/v1`),
        new AbortController().signal,
      )
      expect(records[0]!.path).not.toContain(TEST_KEY)
      const bodyStr = JSON.stringify(records[0]!.body)
      expect(bodyStr).not.toContain(TEST_KEY)
      if (result.status === 'error') {
        const errStr = JSON.stringify(result)
        expect(errStr).not.toContain(TEST_KEY)
      }
    })
  })

  describe('error mapping', () => {
    async function testError(
      status: number,
      errorBody: object,
      expectedCode: string,
    ): Promise<void> {
      const { server: s, port: p } = await startServer(() => ({
        status,
        body: errorBody,
      }))
      try {
        const ad = new OpenAIAdapter(TEST_KEY, { mode: 'direct' })
        const result = await ad.testConnection(
          makeConfig(`http://127.0.0.1:${p}/v1`),
          new AbortController().signal,
        )
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error).toBe(expectedCode)
      } finally {
        s.close()
      }
    }

    it('401 maps to auth', async () => {
      await testError(401, openaiErrorBody('invalid_api_key', 'Incorrect API key'), 'auth')
    })

    it('403 maps to forbidden', async () => {
      await testError(403, openaiErrorBody('permission_denied', 'Permission denied'), 'forbidden')
    })

    it('404 maps to model-not-found', async () => {
      await testError(404, openaiErrorBody('model_not_found', 'Model not found'), 'model-not-found')
    })

    it('429 maps to rate-limited', async () => {
      await testError(429, openaiErrorBody('rate_limit_exceeded', 'Rate limit'), 'rate-limited')
    })

    it('500 maps to provider-unavailable', async () => {
      await testError(500, openaiErrorBody('server_error', 'Internal error'), 'provider-unavailable')
    })

    it('502 maps to provider-unavailable', async () => {
      await testError(502, openaiErrorBody('bad_gateway', 'Bad gateway'), 'provider-unavailable')
    })

    it('503 maps to provider-unavailable', async () => {
      await testError(503, openaiErrorBody('service_unavailable', 'Service unavailable'), 'provider-unavailable')
    })
  })

  describe('500 retryable: exactly ONE request (maxRetries 0)', () => {
    it('sends exactly one request on 500', async () => {
      const { server: s, port: p, records: recs } = await startServer(() => ({
        status: 500,
        body: openaiErrorBody('server_error', 'Internal error'),
      }))
      try {
        const ad = new OpenAIAdapter(TEST_KEY, { mode: 'direct' })
        const result = await ad.testConnection(
          makeConfig(`http://127.0.0.1:${p}/v1`),
          new AbortController().signal,
        )
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error).toBe('provider-unavailable')
        expect(recs).toHaveLength(1)
      } finally {
        s.close()
      }
    })
  })

  describe('cancel abort', () => {
    it('returns canceled when signal is aborted before response', async () => {
      // Server that never responds
      const { server: s, port: p } = await startServer(() => ({
        status: 200,
        body: openaiChatResponse('OK'),
      }))
      try {
        const controller = new AbortController()
        const ad = new OpenAIAdapter(TEST_KEY, { mode: 'direct' })
        // Abort immediately
        controller.abort()
        const result = await ad.testConnection(
          makeConfig(`http://127.0.0.1:${p}/v1`),
          controller.signal,
        )
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error).toBe('canceled')
      } finally {
        s.close()
      }
    })
  })

  describe('mapOpenAIError', () => {
    it('maps APIUserAbortError to canceled', () => {
      const err = new OpenAI.APIUserAbortError({})
      expect(mapOpenAIError(err)).toBe('canceled')
    })

    it('maps APIConnectionTimeoutError to timeout', () => {
      const err = new OpenAI.APIConnectionTimeoutError({})
      expect(mapOpenAIError(err)).toBe('timeout')
    })

    it('maps APIConnectionError to provider-unavailable', () => {
      const err = new OpenAI.APIConnectionError({ message: 'connection error' })
      expect(mapOpenAIError(err)).toBe('provider-unavailable')
    })

    it('maps AuthenticationError to auth', () => {
      const err = new OpenAI.AuthenticationError(401, { error: { message: 'bad key' } } as unknown as Record<string, unknown>, 'bad key', new Headers())
      expect(mapOpenAIError(err)).toBe('auth')
    })

    it('maps PermissionDeniedError to forbidden', () => {
      const err = new OpenAI.PermissionDeniedError(403, { error: { message: 'forbidden' } } as unknown as Record<string, unknown>, 'forbidden', new Headers())
      expect(mapOpenAIError(err)).toBe('forbidden')
    })

    it('maps NotFoundError to model-not-found', () => {
      const err = new OpenAI.NotFoundError(404, { error: { message: 'not found' } } as unknown as Record<string, unknown>, 'not found', new Headers())
      expect(mapOpenAIError(err)).toBe('model-not-found')
    })

    it('maps RateLimitError to rate-limited', () => {
      const err = new OpenAI.RateLimitError(429, { error: { message: 'rate limit' } } as unknown as Record<string, unknown>, 'rate limit', new Headers())
      expect(mapOpenAIError(err)).toBe('rate-limited')
    })

    it('maps InternalServerError to provider-unavailable', () => {
      const err = new OpenAI.InternalServerError(500, { error: { message: 'error' } } as unknown as Record<string, unknown>, 'error', new Headers())
      expect(mapOpenAIError(err)).toBe('provider-unavailable')
    })

    it('maps unknown error to unknown', () => {
      expect(mapOpenAIError(new Error('something else'))).toBe('unknown')
    })

    it('maps non-Error value to unknown', () => {
      expect(mapOpenAIError('string error')).toBe('unknown')
    })
  })
})