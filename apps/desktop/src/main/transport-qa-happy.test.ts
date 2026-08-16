/**
 * QA happy path: six transport combinations (Hub API + download worker ×
 * System/Direct/Manual) against a LOCAL origin + recording proxy, printing the
 * exact connection logs for evidence (qa-happy.txt). No overseas network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTaskFetch, ProxyTransportManager } from './transport'
import { proxyUrlFromResolution } from './transport'
import { createWorkerTransport } from './workers/download-worker'
import { startOriginServer, startRecordingProxy } from './test/proxy-fixtures'

vi.mock('electron', () => ({
  session: {
    fromPartition: () => ({
      setProxy: vi.fn(async () => undefined),
      resolveProxy: vi.fn(async () => 'DIRECT'),
      closeAllConnections: vi.fn()
    })
  }
}))

const ORIGIN_BODY = 'qa-happy-body'

describe('QA happy — six transport combinations', () => {
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

  const log = (label: string, value: unknown): void => {
    console.log(`[qa-happy] ${label}: ${JSON.stringify(value)}`)
  }

  it('1/6 hub-api System — PAC route translated and tunneled through the proxy', async () => {
    const resolver = async (_url: string): Promise<string | null> =>
      proxyUrlFromResolution(`PROXY ${new URL(proxy.url).host}; DIRECT`)
    const { fetchImpl } = createTaskFetch({ mode: 'system' }, { resolver })
    const res = await fetchImpl(`${origin.url}/hub-api-system.bin`)
    const text = await res.text()
    log('hub-api/system/body', text)
    log('hub-api/system/proxy.requests', proxy.requests)
    log('hub-api/system/origin.requests', origin.requests)
    expect(text).toBe(ORIGIN_BODY)
    expect(proxy.requests.some((r) => r.method === 'CONNECT')).toBe(true)
    expect(origin.requests.some((r) => r.url.includes('/hub-api-system.bin'))).toBe(true)
  })

  it('2/6 hub-api Direct — bypasses the proxy entirely', async () => {
    const { fetchImpl } = createTaskFetch({ mode: 'direct' })
    const res = await fetchImpl(`${origin.url}/hub-api-direct.bin`)
    const text = await res.text()
    log('hub-api/direct/body', text)
    log('hub-api/direct/proxy.requests', proxy.requests)
    log('hub-api/direct/origin.requests', origin.requests)
    expect(text).toBe(ORIGIN_BODY)
    expect(proxy.requests.length).toBe(0)
    expect(origin.requests.length).toBe(1)
  })

  it('3/6 hub-api Manual — pinned proxy URL, tunneled', async () => {
    const { fetchImpl } = createTaskFetch({ mode: 'manual', url: proxy.url })
    const res = await fetchImpl(`${origin.url}/hub-api-manual.bin`)
    const text = await res.text()
    log('hub-api/manual/body', text)
    log('hub-api/manual/proxy.requests', proxy.requests)
    log('hub-api/manual/origin.requests', origin.requests)
    expect(text).toBe(ORIGIN_BODY)
    expect(proxy.requests.some((r) => r.method === 'CONNECT')).toBe(true)
    expect(origin.requests.some((r) => r.url.includes('/hub-api-manual.bin'))).toBe(true)
  })

  it('4/6 worker System — resolved proxy URL routes the worker', async () => {
    const transport = createWorkerTransport({ mode: 'system', url: proxy.url })
    try {
      const res = await transport.httpFetch(`${origin.url}/worker-system.bin`)
      const text = await res.text()
      log('worker/system/body', text)
      log('worker/system/proxy.requests', proxy.requests)
      log('worker/system/origin.requests', origin.requests)
      expect(text).toBe(ORIGIN_BODY)
      expect(proxy.requests.some((r) => r.method === 'CONNECT')).toBe(true)
      expect(origin.requests.some((r) => r.url.includes('/worker-system.bin'))).toBe(true)
    } finally {
      await transport.close()
    }
  })

  it('5/6 worker Direct — never touches a proxy', async () => {
    const transport = createWorkerTransport({ mode: 'direct' })
    try {
      const res = await transport.httpFetch(`${origin.url}/worker-direct.bin`)
      const text = await res.text()
      log('worker/direct/body', text)
      log('worker/direct/proxy.requests', proxy.requests)
      log('worker/direct/origin.requests', origin.requests)
      expect(text).toBe(ORIGIN_BODY)
      expect(proxy.requests.length).toBe(0)
      expect(origin.requests.length).toBe(1)
    } finally {
      await transport.close()
    }
  })

  it('6/6 worker Manual — pinned proxy URL, tunneled', async () => {
    const transport = createWorkerTransport({ mode: 'manual', url: proxy.url })
    try {
      const res = await transport.httpFetch(`${origin.url}/worker-manual.bin`)
      const text = await res.text()
      log('worker/manual/body', text)
      log('worker/manual/proxy.requests', proxy.requests)
      log('worker/manual/origin.requests', origin.requests)
      expect(text).toBe(ORIGIN_BODY)
      expect(proxy.requests.some((r) => r.method === 'CONNECT')).toBe(true)
      expect(origin.requests.some((r) => r.url.includes('/worker-manual.bin'))).toBe(true)
    } finally {
      await transport.close()
    }
  })

  it('concurrent tasks with different snapshots use distinct per-task sessions', async () => {
    const manager = new ProxyTransportManager()
    const manual = manager.transportFor('task-manual', { mode: 'manual', url: proxy.url })
    const direct = manager.transportFor('task-direct', { mode: 'direct' })
    log('per-task/partitions', [manual.partition, direct.partition])
    expect(manual.partition).not.toBe(direct.partition)
    expect(new Set([manual.ses, direct.ses]).size).toBe(2)
    await manager.closeAll()
  })

  it('settings change during transfer cannot affect a frozen snapshot', async () => {
    // A frozen manual snapshot keeps routing through the ORIGINAL proxy even
    // after a newer settings value points elsewhere.
    const frozen = { mode: 'manual' as const, url: proxy.url }
    const laterSettingsUrl = 'http://127.0.0.1:65530'
    const { fetchImpl } = createTaskFetch(frozen)
    const res = await fetchImpl(`${origin.url}/frozen.bin`)
    const text = await res.text()
    log('frozen/settings-at-fetch', { frozen, laterSettingsUrl })
    log('frozen/proxy.requests', proxy.requests)
    expect(text).toBe(ORIGIN_BODY)
    expect(proxy.requests.some((r) => r.method === 'CONNECT')).toBe(true)
    expect(frozen.url).not.toBe(laterSettingsUrl)
  })
})
