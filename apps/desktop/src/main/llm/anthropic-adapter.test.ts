/**
 * Todo 7 — Anthropic adapter wire tests.
 *
 * Local node:http server on 127.0.0.1:0 proves:
 * - probe and translation call on /v1/messages with configured model
 * - x-api-key header present (SDK-owned Anthropic header)
 * - one request on retryable failure (maxRetries 0)
 * - text-block extraction from multi-block response
 * - non-text/empty/refusal handling
 * - cancel/timeout
 * - 401/403/404/429/5xx → typed errors, no key leakage
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, assert } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { AnthropicAdapter, LlmAdapterError } from './anthropic-adapter'
import type { LlmProviderConfig, LlmTranslateRequest } from '@hubfetch/shared'

// ---------------------------------------------------------------------------
// Test server helpers
// ---------------------------------------------------------------------------

interface RequestLogEntry {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

function createTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler)
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'))
        return
      }
      resolve({ server, port: addr.port })
    })
  })
}

function collectBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data).toString(),
  })
  res.end(data)
}

function anthropicMessage(texts: string[], stopReason = 'end_turn') {
  return {
    id: 'msg_test_001',
    type: 'message',
    role: 'assistant',
    content: texts.map((t) => ({ type: 'text', text: t })),
    model: 'claude-3-haiku-20240307',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: texts.join('').length },
  }
}

function anthropicError(status: number, message: string) {
  return {
    type: 'error',
    error: {
      type: status === 429 ? 'rate_limit_error'
        : status === 401 ? 'authentication_error'
        : status === 403 ? 'permission_error'
        : status === 404 ? 'not_found_error'
        : 'api_error',
      message,
    },
  }
}

// ---------------------------------------------------------------------------
// Custom fetch that routes to the local test server
// ---------------------------------------------------------------------------

function localFetch(port: number): typeof fetch {
  return async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const parsed = new URL(urlStr)
    const localUrl = `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`
    return fetch(localUrl, init)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicAdapter', () => {
  let server: Server
  let port: number
  let requestLog: RequestLogEntry[]
  let handlerFn: (req: IncomingMessage, res: ServerResponse) => void

  beforeAll(async () => {
    requestLog = []
    handlerFn = (_req, _res) => {
      // Default handler — overridden per test
    }
    const result = await createTestServer((req, res) => {
      // Log every request
      collectBody(req).then((body) => {
        requestLog.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers as Record<string, string>,
          body: body ? JSON.parse(body) : null,
        })
      })
      handlerFn(req, res)
    })
    server = result.server
    port = result.port
  })

  afterAll(() => {
    server?.close()
  })

  beforeEach(() => {
    requestLog = []
    handlerFn = (_req, res) => {
      jsonResponse(res, 200, anthropicMessage(['OK']))
    }
  })

  function createAdapter(
    apiKey: string,
    modelId: string,
    opts?: { baseURL?: string; timeout?: number },
  ): AnthropicAdapter {
    return new AnthropicAdapter(apiKey, modelId, {
      baseURL: opts?.baseURL ?? `http://127.0.0.1:${port}`,
      fetch: localFetch(port),
      timeout: opts?.timeout ?? 60_000,
    })
  }

  const testConfig: LlmProviderConfig = { modelId: 'claude-3-haiku-20240307', baseUrl: null }
  const testRequest: LlmTranslateRequest = {
    requestId: 'test-r1',
    markdown: '# Hello\n\nThis is a test.',
    targetLocale: 'fr',
  }

  // -----------------------------------------------------------------------
  // Probe (testConnection)
  // -----------------------------------------------------------------------

  describe('testConnection', () => {
    it('sends a minimal probe to /v1/messages with the configured model', async () => {
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      const result = await adapter.testConnection(testConfig, new AbortController().signal)

      expect(result.ok).toBe(true)
      expect(requestLog).toHaveLength(1)
      const entry = requestLog[0]!
      expect(entry.method).toBe('POST')
      expect(entry.url).toBe('/v1/messages')
      expect((entry.body as any)?.model).toBe('claude-3-haiku-20240307')
      expect((entry.body as any)?.max_tokens).toBe(1)
    })

    it('sends x-api-key header', async () => {
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      await adapter.testConnection(testConfig, new AbortController().signal)

      expect(requestLog[0]!.headers['x-api-key']).toBe('sk-ant-test-key')
    })

    it('returns latency on success', async () => {
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      const result = await adapter.testConnection(testConfig, new AbortController().signal)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.latencyMs).toBeGreaterThanOrEqual(0)
      }
    })

    it('returns empty-response when content has no text blocks', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 200, {
          id: 'msg_test_002',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'test', input: {} }],
          model: 'claude-3-haiku-20240307',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        })
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      const result = await adapter.testConnection(testConfig, new AbortController().signal)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('empty-response')
    })

    it('returns empty-response when text is whitespace only', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 200, anthropicMessage(['   \n  ']))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      const result = await adapter.testConnection(testConfig, new AbortController().signal)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('empty-response')
    })

    it('returns auth on 401', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 401, anthropicError(401, 'Invalid API key'))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      const result = await adapter.testConnection(testConfig, new AbortController().signal)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('auth')
    })

    it('returns forbidden on 403', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 403, anthropicError(403, 'Permission denied'))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      const result = await adapter.testConnection(testConfig, new AbortController().signal)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('forbidden')
    })

    it('returns model-not-found on 404', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 404, anthropicError(404, 'Model not found'))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      const result = await adapter.testConnection(testConfig, new AbortController().signal)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('model-not-found')
    })

    it('returns rate-limited on 429', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 429, anthropicError(429, 'Rate limit exceeded'))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      const result = await adapter.testConnection(testConfig, new AbortController().signal)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('rate-limited')
    })

    it('returns provider-unavailable on 5xx', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 500, anthropicError(500, 'Internal server error'))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      const result = await adapter.testConnection(testConfig, new AbortController().signal)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('provider-unavailable')
    })

    it('returns timeout on timeout', async () => {
      handlerFn = (_req, res) => {
        // Delay longer than the test timeout
        setTimeout(() => jsonResponse(res, 200, anthropicMessage(['OK'])), 500)
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307', { timeout: 50 })
      const result = await adapter.testConnection(testConfig, new AbortController().signal)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('timeout')
    })

    it('returns canceled on abort', async () => {
      handlerFn = (_req, res) => {
        // Delay so we can abort first
        setTimeout(() => jsonResponse(res, 200, anthropicMessage(['OK'])), 500)
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 20)
      const result = await adapter.testConnection(testConfig, controller.signal)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('canceled')
    })

    it('makes exactly one request on retryable failure (maxRetries 0)', async () => {
      let callCount = 0
      handlerFn = (_req, res) => {
        callCount++
        jsonResponse(res, 500, anthropicError(500, 'Internal server error'))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      await adapter.testConnection(testConfig, new AbortController().signal)

      expect(callCount).toBe(1)
    })

    it('does not leak API key in error result', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 401, anthropicError(401, 'Invalid API key'))
      }
      const adapter = createAdapter('sk-ant-test-key-sk-test-value', 'claude-3-haiku-20240307')
      const result = await adapter.testConnection(testConfig, new AbortController().signal)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        // The error code is a string literal, not the key
        expect(result.error).toBe('auth')
        // The result object should not contain the key
        const resultStr = JSON.stringify(result)
        expect(resultStr).not.toContain('sk-ant-test-key-sk-test-value')
      }
    })
  })

  // -----------------------------------------------------------------------
  // Translation
  // -----------------------------------------------------------------------

  describe('translate', () => {
    it('sends a translation request to /v1/messages with configured model', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 200, anthropicMessage([
          '{"status":"translated","sourceLanguage":"en","markdown":"# Bonjour\\n\\nCeci est un test."}',
        ]))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      const result = await adapter.translate(testRequest, new AbortController().signal)

      expect(result.status).toBe('translated')
      expect(requestLog).toHaveLength(1)
      const entry = requestLog[0]!
      expect(entry.method).toBe('POST')
      expect(entry.url).toBe('/v1/messages')
      expect((entry.body as any)?.model).toBe('claude-3-haiku-20240307')
    })

    it('extracts text blocks from multi-block response with non-text blocks', async () => {
      // Response has 3 text blocks and 1 tool_use block — only text blocks should be joined
      handlerFn = (_req, res) => {
        jsonResponse(res, 200, {
          id: 'msg_test_multi2',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: '{"status":"translated","sourceLanguage":"en","markdown":"' },
            { type: 'tool_use', id: 'tool_1', name: 'test', input: {} },
            { type: 'text', text: '# Extracted\\n\\n' },
            { type: 'text', text: 'Content"}' },
          ],
          model: 'claude-3-haiku-20240307',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 25 },
        })
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      const result = await adapter.translate(testRequest, new AbortController().signal)

      expect(result.status).toBe('translated')
      if (result.status === 'translated') {
        // Non-text blocks should be ignored; only text blocks joined in order
        expect(result.markdown).toBe('# Extracted\n\nContent')
      }
    })

    it('joins text blocks in order', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 200, {
          id: 'msg_test_003',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: '{"status":"translated","sourceLanguage":"en","markdown":"' },
            { type: 'text', text: '# Joined\\n\\nContent"}' },
          ],
          model: 'claude-3-haiku-20240307',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 20 },
        })
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      const result = await adapter.translate(testRequest, new AbortController().signal)

      expect(result.status).toBe('translated')
      if (result.status === 'translated') {
        expect(result.markdown).toBe('# Joined\n\nContent')
      }
    })

    it('throws refused on refusal stop_reason', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 200, anthropicMessage(['Some text'], 'refusal'))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')

      await expect(adapter.translate(testRequest, new AbortController().signal))
        .rejects.toMatchObject({ code: 'refused' })
    })

    it('throws empty-response when no text blocks', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 200, {
          id: 'msg_test_004',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'test', input: {} }],
          model: 'claude-3-haiku-20240307',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        })
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')

      await expect(adapter.translate(testRequest, new AbortController().signal))
        .rejects.toMatchObject({ code: 'empty-response' })
    })

    it('throws empty-response when text is empty after join', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 200, anthropicMessage(['']))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')

      await expect(adapter.translate(testRequest, new AbortController().signal))
        .rejects.toMatchObject({ code: 'empty-response' })
    })

    it('throws canceled on abort', async () => {
      handlerFn = (_req, res) => {
        setTimeout(() => jsonResponse(res, 200, anthropicMessage(['OK'])), 500)
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 20)

      await expect(adapter.translate(testRequest, controller.signal))
        .rejects.toMatchObject({ code: 'canceled' })
    })

    it('throws timeout on timeout', async () => {
      handlerFn = (_req, res) => {
        setTimeout(() => jsonResponse(res, 200, anthropicMessage(['OK'])), 500)
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307', { timeout: 50 })

      await expect(adapter.translate(testRequest, new AbortController().signal))
        .rejects.toMatchObject({ code: 'timeout' })
    })

    it('throws auth on 401', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 401, anthropicError(401, 'Invalid API key'))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')

      await expect(adapter.translate(testRequest, new AbortController().signal))
        .rejects.toMatchObject({ code: 'auth' })
    })

    it('throws forbidden on 403', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 403, anthropicError(403, 'Permission denied'))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')

      await expect(adapter.translate(testRequest, new AbortController().signal))
        .rejects.toMatchObject({ code: 'forbidden' })
    })

    it('throws model-not-found on 404', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 404, anthropicError(404, 'Model not found'))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')

      await expect(adapter.translate(testRequest, new AbortController().signal))
        .rejects.toMatchObject({ code: 'model-not-found' })
    })

    it('throws rate-limited on 429', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 429, anthropicError(429, 'Rate limit exceeded'))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')

      await expect(adapter.translate(testRequest, new AbortController().signal))
        .rejects.toMatchObject({ code: 'rate-limited' })
    })

    it('throws provider-unavailable on 5xx', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 500, anthropicError(500, 'Internal server error'))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')

      await expect(adapter.translate(testRequest, new AbortController().signal))
        .rejects.toMatchObject({ code: 'provider-unavailable' })
    })

    it('makes exactly one request on retryable failure (maxRetries 0)', async () => {
      let callCount = 0
      handlerFn = (_req, res) => {
        callCount++
        jsonResponse(res, 500, anthropicError(500, 'Server error'))
      }
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')

      await expect(adapter.translate(testRequest, new AbortController().signal))
        .rejects.toThrow()

      expect(callCount).toBe(1)
    })

    it('does not leak API key in error', async () => {
      handlerFn = (_req, res) => {
        jsonResponse(res, 401, anthropicError(401, 'Invalid API key'))
      }
      const adapter = createAdapter('sk-ant-test-key-sk-test-value', 'claude-3-haiku-20240307')

      try {
        await adapter.translate(testRequest, new AbortController().signal)
        assert.fail('Should have thrown')
      } catch (err) {
        const errStr = String(err)
        expect(errStr).not.toContain('sk-ant-test-key-sk-test-value')
      }
    })
  })

  // -----------------------------------------------------------------------
  // Interface compliance
  // -----------------------------------------------------------------------

  describe('interface compliance', () => {
    it('has provider set to anthropic', () => {
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      expect(adapter.provider).toBe('anthropic')
    })

    it('implements LlmAdapter interface', () => {
      const adapter = createAdapter('sk-ant-test-key', 'claude-3-haiku-20240307')
      expect(adapter.testConnection).toBeInstanceOf(Function)
      expect(adapter.translate).toBeInstanceOf(Function)
    })
  })
})