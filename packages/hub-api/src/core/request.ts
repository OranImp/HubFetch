export type JsonMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export function buildJsonRequest(
  method: JsonMethod,
  body: unknown,
  headers: Record<string, string>
): RequestInit {
  return {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }
}

/** Total file size: Content-Range wins over Content-Length. */
export function totalSizeFrom(response: Response, received: number): number {
  const total = response.headers.get('Content-Range')?.match(/\/(\d+)$/)?.[1]
  if (total) return Number(total)
  const length = Number(response.headers.get('Content-Length'))
  return Number.isFinite(length) && length > 0 ? length : received
}

/** Read at most maxBytes, cancelling a streamed response once the cap is crossed. */
export async function readBodyCapped(
  response: Response,
  maxBytes: number
): Promise<{ bytes: Uint8Array; capped: boolean }> {
  const reader = response.body?.getReader()
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.byteLength > maxBytes
      ? { bytes: bytes.slice(0, maxBytes), capped: true }
      : { bytes, capped: false }
  }
  const chunks: Uint8Array[] = []
  let received = 0
  let capped = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    if (received > maxBytes) {
      capped = true
      await reader.cancel().catch(() => undefined)
      break
    }
  }
  const bytes = new Uint8Array(Math.min(received, maxBytes))
  let offset = 0
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, bytes.byteLength - offset)
    bytes.set(take === chunk.byteLength ? chunk : chunk.subarray(0, take), offset)
    offset += take
    if (offset === bytes.byteLength) break
  }
  return { bytes, capped }
}

/** Name=value pairs from Set-Cookie response headers, with attributes removed. */
export function cookiePairsFromResponse(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const lines =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (() => {
          const one = response.headers.get('set-cookie')
          return one ? [one] : []
        })()
  const pairs: string[] = []
  for (const line of lines) {
    const pair = line.split(';', 1)[0]?.trim()
    if (pair && pair.includes('=')) pairs.push(pair)
  }
  return pairs
}
