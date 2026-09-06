import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  POSTS,
  RATE_LIMIT_BODY,
  RETRY_BODY,
  SAME_LANG_BODY,
  SLOW_BODY,
  SYNTHETIC_KEY,
  TRANSLATED_BODY,
  type LedgerEntry,
  type WireFakes
} from './post-translation-harness'

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function geminiText(text: string): string {
  return JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }]
  })
}

function hubPost(post: (typeof POSTS)[number]): unknown {
  return {
    slug: post.slug,
    author: { name: post.author, fullname: 'E2E User' },
    rawContent: post.rawContent,
    publishedAt: '2026-08-01T00:00:00.000Z',
    numComments: 0,
    reactions: [],
    attachments: [],
    url: `/posts/${post.author}/${post.slug}`
  }
}

function promptText(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as {
      contents?: ReadonlyArray<{ parts?: ReadonlyArray<{ text?: string }> }>
    }
    return parsed.contents?.[0]?.parts?.[0]?.text ?? ''
  } catch {
    return ''
  }
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  server: Server
  url: string
}> {
  const server = createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

function envelope(status: 'translated' | 'same-language', markdown?: string): string {
  if (status === 'same-language') {
    return JSON.stringify({ status, sourceLanguage: 'en' })
  }
  return JSON.stringify({ status, sourceLanguage: 'en', markdown })
}

export async function startWireFakes(): Promise<WireFakes> {
  const ledger: LedgerEntry[] = []
  let rateLimitHits = 0
  let inflightSlow = 0

  const hub = await listen((req, res) => {
    const path = req.url ?? '/'
    ledger.push({
      kind: 'hub',
      method: req.method ?? '',
      path,
      googKeyHeader: false,
      keyInUrl: path.includes(SYNTHETIC_KEY),
      keyInBody: false,
      aborted: false
    })
    if (path.startsWith('/api/posts')) {
      const slug = new URL(path, 'http://127.0.0.1').searchParams.get('slug')
      const items = POSTS.filter((post) => slug === null || post.slug === slug).map(hubPost)
      sendJson(res, 200, { socialPosts: items, numTotalItems: items.length })
      return
    }
    if (
      path.startsWith('/api/daily_papers') ||
      path.startsWith('/api/models') ||
      path.startsWith('/api/datasets') ||
      path.startsWith('/api/spaces')
    ) {
      sendJson(res, 200, [])
      return
    }
    sendJson(res, 200, {})
  })

  const gemini = await listen((req, res) => {
    const path = req.url ?? '/'
    const entry: LedgerEntry = {
      kind: 'gemini',
      method: req.method ?? '',
      path,
      googKeyHeader: req.headers['x-goog-api-key'] === SYNTHETIC_KEY,
      keyInUrl: path.includes(SYNTHETIC_KEY) || path.includes('key='),
      keyInBody: false,
      aborted: false
    }
    ledger.push(entry)
    const socket = req.socket
    socket.on('close', () => {
      if (entry.aborted || res.writableEnded) return
      entry.aborted = true
      inflightSlow = Math.max(0, inflightSlow - 1)
    })
    readBody(req)
      .then((rawBody) => {
        entry.keyInBody = rawBody.includes(SYNTHETIC_KEY)
        replyGemini(req, res, entry, promptText(rawBody), () => {
          rateLimitHits += 1
        }, () => rateLimitHits, () => {
          inflightSlow += 1
        })
      })
      .catch((err: unknown) => {
        if (!res.writableEnded) res.end()
        if (err instanceof Error) return
        throw err
      })
  })

  return {
    hubUrl: hub.url,
    geminiUrl: gemini.url,
    ledger,
    get rateLimitHits() {
      return rateLimitHits
    },
    set rateLimitHits(value: number) {
      rateLimitHits = value
    },
    get inflightSlow() {
      return inflightSlow
    },
    set inflightSlow(value: number) {
      inflightSlow = value
    },
    close: async () => {
      await closeServer(hub.server)
      await closeServer(gemini.server)
    }
  }
}

function replyGemini(
  _req: IncomingMessage,
  res: ServerResponse,
  _entry: LedgerEntry,
  prompt: string,
  bumpLimit: () => void,
  hits: () => number,
  beginSlow: () => void
): void {
  if (prompt === 'OK') {
    sendJson(res, 200, geminiText('OK'))
    return
  }
  if (prompt.includes(RATE_LIMIT_BODY) && hits() < 1) {
    bumpLimit()
    sendJson(res, 429, { error: { message: 'rate limited' } })
    return
  }
  if (prompt.includes(SLOW_BODY)) {
    beginSlow()
    return
  }
  if (prompt.includes(SAME_LANG_BODY)) {
    sendJson(res, 200, geminiText(envelope('same-language')))
    return
  }
  const markdown = prompt.includes(RATE_LIMIT_BODY) ? RETRY_BODY : TRANSLATED_BODY
  sendJson(res, 200, geminiText(envelope('translated', markdown)))
}
