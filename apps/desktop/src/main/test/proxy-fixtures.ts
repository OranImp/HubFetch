/**
 * Local HTTP fixtures for transport tests: a plain origin server and a
 * recording forward proxy, both bound to 127.0.0.1. Never touches the
 * network outside this machine (NO overseas calls; used only by vitest).
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect as tcpConnect } from 'node:net'
import type { AddressInfo } from 'node:net'

export interface RequestLog {
  method: string
  url: string
}

export interface OriginServer {
  url: string
  requests: RequestLog[]
  close(): Promise<void>
}

export async function startOriginServer(body = 'fixture-body-ok'): Promise<OriginServer> {
  const requests: RequestLog[] = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' })
    const bytes = Buffer.from(body)
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Length': String(bytes.byteLength)
    })
    res.end(bytes)
  })
  await listen(server)
  return { url: originUrl(server), requests, close: () => closeServer(server) }
}

export interface ProxyServer {
  url: string
  requests: RequestLog[]
  close(): Promise<void>
}

/**
 * Recording proxy that satisfies both proxy idioms:
 *  - `connect` events: CONNECT tunnel to the target (undici ProxyAgent always
 *    tunnels, even for http origins), then raw TCP piping both ways.
 *  - plain requests: absolute-URI forwarding to the origin.
 */
export async function startRecordingProxy(): Promise<ProxyServer> {
  const requests: RequestLog[] = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' })
    let target: URL
    try {
      target = new URL(req.url ?? '')
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('bad proxy request line')
      return
    }
    const fwd = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...req.headers, host: target.host }
      },
      (fwdRes) => {
        res.writeHead(fwdRes.statusCode ?? 502, fwdRes.headers)
        fwdRes.pipe(res)
      }
    )
    fwd.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' })
      }
      res.end('proxy forward failed')
    })
    req.pipe(fwd)
  })

  server.on('connect', (req, clientSocket, head) => {
    requests.push({ method: 'CONNECT', url: req.url ?? '' })
    let target: URL
    try {
      target = new URL(`http://${req.url ?? ''}`)
    } catch {
      clientSocket.destroy()
      return
    }
    const upstream = tcpConnect(Number(target.port) || 80, target.hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })

  await listen(server)
  return { url: originUrl(server), requests, close: () => closeServer(server) }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

function originUrl(server: Server): string {
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}
