import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const FIXTURE_MODEL_ID = 'fixture-org/tiny-gpt'
export const FIXTURE_README = [
  '# Tiny GPT',
  '',
  'Fixture model card for HubFetch visual regression.',
  '',
  '- Architecture: decoder-only',
  '- License: Apache-2.0'
].join('\n')

const FROZEN_AT = '2026-01-15T00:00:00.000Z'

const MODELS = [
  {
    id: FIXTURE_MODEL_ID,
    modelId: FIXTURE_MODEL_ID,
    author: 'fixture-org',
    likes: 42,
    downloads: 128000,
    lastModified: FROZEN_AT,
    createdAt: '2025-06-01T00:00:00.000Z',
    private: false,
    gated: false,
    pipeline_tag: 'text-generation',
    library_name: 'transformers',
    tags: ['transformers', 'pytorch', 'text-generation', 'en', 'license:apache-2.0'],
    safetensors: { total: 124_000_000 },
    sha: 'a'.repeat(40),
    siblings: [
      { rfilename: 'config.json', size: 512 },
      { rfilename: 'README.md', size: 256 }
    ]
  },
  {
    id: 'fixture-org/vision-net',
    modelId: 'fixture-org/vision-net',
    author: 'fixture-org',
    likes: 17,
    downloads: 54000,
    lastModified: FROZEN_AT,
    createdAt: '2025-08-01T00:00:00.000Z',
    private: false,
    gated: false,
    pipeline_tag: 'image-classification',
    library_name: 'transformers',
    tags: ['transformers', 'image-classification', 'license:mit'],
    safetensors: { total: 88_000_000 },
    sha: 'b'.repeat(40)
  },
  {
    id: 'fixture-org/speech-tiny',
    modelId: 'fixture-org/speech-tiny',
    author: 'fixture-org',
    likes: 9,
    downloads: 21000,
    lastModified: FROZEN_AT,
    createdAt: '2025-09-01T00:00:00.000Z',
    private: false,
    gated: false,
    pipeline_tag: 'automatic-speech-recognition',
    library_name: 'transformers',
    tags: ['transformers', 'asr', 'license:apache-2.0'],
    safetensors: { total: 39_000_000 },
    sha: 'c'.repeat(40)
  }
] as const

export type HubFixture = {
  readonly url: string
  close: () => Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function sendText(res: ServerResponse, status: number, body: string, type: string): void {
  if (res.writableEnded) return
  res.writeHead(status, { 'Content-Type': type })
  res.end(body)
}

function modelDetail(id: string): (typeof MODELS)[number] | undefined {
  return MODELS.find((model) => model.id === id)
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname

  if (path === '/api/models') {
    sendJson(res, 200, MODELS)
    return
  }
  const modelMatch = path.match(/^\/api\/models\/([^/]+\/[^/]+)$/)
  if (modelMatch) {
    const detail = modelDetail(decodeURIComponent(modelMatch[1] ?? ''))
    if (!detail) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    sendJson(res, 200, { ...detail, inference: 'cold', inferenceProviderMapping: {} })
    return
  }
  if (path.endsWith('/README.md')) {
    sendText(res, 200, FIXTURE_README, 'text/plain; charset=utf-8')
    return
  }
  if (path.includes('/discussions')) {
    sendJson(res, 200, { discussions: [], count: 0, start: 0 })
    return
  }
  if (path.includes('/tree/')) {
    sendJson(res, 200, [])
    return
  }
  if (path.startsWith('/api/posts') || path.startsWith('/api/daily_papers')) {
    sendJson(res, 200, [])
    return
  }
  sendJson(res, 200, {})
}

export async function startHubFixture(): Promise<HubFixture> {
  const server: Server = createServer(handle)
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}
