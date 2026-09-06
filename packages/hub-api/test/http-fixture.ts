import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface FixtureRequest {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: Uint8Array
}

export interface FixtureResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string | Uint8Array
}

export interface HttpFixture {
  readonly url: string
  readonly requests: FixtureRequest[]
  waitForRequests(count: number): Promise<void>
  close(): Promise<void>
}

type FixtureHandler = (request: FixtureRequest) => FixtureResponse | Promise<FixtureResponse>

function headerValues(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = Array.isArray(value) ? value.join(', ') : (value ?? '')
  }
  return headers
}

async function requestBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function writeResponse(response: ServerResponse, result: FixtureResponse): void {
  response.writeHead(result.status, result.headers)
  response.end(result.body)
}

export async function startHttpFixture(handler: FixtureHandler): Promise<HttpFixture> {
  const requests: FixtureRequest[] = []
  const requestWaiters = new Map<number, Array<() => void>>()
  const notifyRequestWaiters = (): void => {
    for (const [count, waiters] of requestWaiters) {
      if (requests.length < count) continue
      requestWaiters.delete(count)
      for (const resolve of waiters) resolve()
    }
  }
  const server = createServer(async (request, response) => {
    const entry: FixtureRequest = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: headerValues(request),
      body: await requestBody(request)
    }
    requests.push(entry)
    notifyRequestWaiters()
    writeResponse(response, await handler(entry))
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('fixture server did not expose a TCP address')
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    waitForRequests: (count) => {
      if (requests.length >= count) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const waiters = requestWaiters.get(count) ?? []
        waiters.push(resolve)
        requestWaiters.set(count, waiters)
      })
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}
