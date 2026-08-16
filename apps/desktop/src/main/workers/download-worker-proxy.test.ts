import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkerTransport } from './download-worker'
import { startOriginServer, startRecordingProxy } from '../test/proxy-fixtures'

const ORIGIN_BODY = 'worker-fixture-body'

describe('download worker transport (three proxy modes)', () => {
  let origin: Awaited<ReturnType<typeof startOriginServer>>
  let proxy: Awaited<ReturnType<typeof startRecordingProxy>>
  const roots: Array<() => Promise<void>> = []

  beforeEach(async () => {
    origin = await startOriginServer(ORIGIN_BODY)
    proxy = await startRecordingProxy()
    roots.push(
      () => origin.close(),
      () => proxy.close()
    )
  })

  afterEach(async () => {
    for (const close of roots.splice(0)) await close().catch(() => undefined)
  })

  it('Manual: worker traffic flows through the pinned proxy URL', async () => {
    const transport = createWorkerTransport({ mode: 'manual', url: proxy.url })
    try {
      const res = await transport.httpFetch(`${origin.url}/file.bin`)
      expect(await res.text()).toBe(ORIGIN_BODY)
      const connects = proxy.requests.filter((r) => r.method === 'CONNECT')
      expect(connects.length).toBeGreaterThan(0)
      expect(connects.some((r) => r.url.includes(new URL(origin.url).port))).toBe(true)
      expect(origin.requests.some((r) => r.url.includes('/file.bin'))).toBe(true)
    } finally {
      await transport.close()
    }
  })

  it('System: a resolved proxy URL routes worker traffic through it', async () => {
    const transport = createWorkerTransport({ mode: 'system', url: proxy.url })
    try {
      const res = await transport.httpFetch(`${origin.url}/sys-file.bin`)
      expect(await res.text()).toBe(ORIGIN_BODY)
      const connects = proxy.requests.filter((r) => r.method === 'CONNECT')
      expect(connects.length).toBeGreaterThan(0)
      expect(connects.some((r) => r.url.includes(new URL(origin.url).port))).toBe(true)
      expect(origin.requests.some((r) => r.url.includes('/sys-file.bin'))).toBe(true)
    } finally {
      await transport.close()
    }
  })

  it('System: an unresolvable/absent proxy URL degrades to direct worker fetch', async () => {
    const transport = createWorkerTransport({ mode: 'system', url: null })
    try {
      const res = await transport.httpFetch(`${origin.url}/direct-file.bin`)
      expect(await res.text()).toBe(ORIGIN_BODY)
      expect(origin.requests.length).toBe(1)
      expect(proxy.requests.length).toBe(0)
    } finally {
      await transport.close()
    }
  })

  it('Direct: never touches a proxy, even one configured in the environment', async () => {
    // Simulate an environment that would trap unproxied DIRECT traffic elsewhere.
    const previous = { ...process.env }
    process.env.HTTP_PROXY = proxy.url
    process.env.HTTPS_PROXY = proxy.url
    process.env.ALL_PROXY = proxy.url
    try {
      const transport = createWorkerTransport({ mode: 'direct' })
      try {
        const res = await transport.httpFetch(`${origin.url}/direct.bin`)
        expect(await res.text()).toBe(ORIGIN_BODY)
        expect(origin.requests.length).toBe(1)
        expect(proxy.requests.length).toBe(0)
      } finally {
        await transport.close()
      }
    } finally {
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  })

  it('undefined proxy policy behaves as Direct (worker default)', async () => {
    const transport = createWorkerTransport(undefined)
    try {
      const res = await transport.httpFetch(`${origin.url}/default.bin`)
      expect(await res.text()).toBe(ORIGIN_BODY)
      expect(proxy.requests.length).toBe(0)
    } finally {
      await transport.close()
    }
  })

  it('close() releases the proxy agent', async () => {
    const transport = createWorkerTransport({ mode: 'manual', url: proxy.url })
    await transport.httpFetch(`${origin.url}/x.bin`)
    // A single close releases the agent's sockets without throwing.
    await transport.close()
    // The origin and proxy remain healthy for a fresh transport afterward.
    const next = createWorkerTransport({ mode: 'direct' })
    const res = await next.httpFetch(`${origin.url}/after.bin`)
    expect(await res.text()).toBe(ORIGIN_BODY)
    await next.close()
  })
})
