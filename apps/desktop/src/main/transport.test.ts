import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent, getGlobalDispatcher, ProxyAgent } from 'undici'
import type { ProxySnapshot } from '@hubfetch/shared'
import {
  DispatcherPool,
  ProxyTransportManager,
  TASK_PARTITION_PREFIX,
  createTaskFetch,
  proxyUrlFromResolution
} from './transport'
import { startOriginServer, startRecordingProxy } from './test/proxy-fixtures'

const electronMocks = vi.hoisted(() => ({
  sessions: new Map<
    string,
    {
      setProxy: ReturnType<typeof vi.fn>
      resolveProxy: ReturnType<typeof vi.fn>
      closeAllConnections: ReturnType<typeof vi.fn>
    }
  >()
}))

vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => {
      let fake = electronMocks.sessions.get(partition)
      if (!fake) {
        fake = {
          setProxy: vi.fn(async () => undefined),
          resolveProxy: vi.fn(async () => 'DIRECT'),
          closeAllConnections: vi.fn()
        }
        electronMocks.sessions.set(partition, fake)
      }
      return fake
    }
  }
}))

const MANUAL: ProxySnapshot = { mode: 'manual', url: 'http://127.0.0.1:7897' }
const DIRECT: ProxySnapshot = { mode: 'direct' }
const SYSTEM: ProxySnapshot = { mode: 'system' }

describe('proxyUrlFromResolution (ordered PROXY/HTTPS/SOCKS/DIRECT)', () => {
  it('translates PROXY to an http URL', () => {
    expect(proxyUrlFromResolution('PROXY 127.0.0.1:6152')).toBe('http://127.0.0.1:6152')
  })

  it('translates HTTPS directives to https URLs and skips DIRECT', () => {
    expect(proxyUrlFromResolution('HTTPS proxy.example:8443; DIRECT')).toBe(
      'https://proxy.example:8443'
    )
  })

  it('skips unsupported SOCKS entries in order and honors later fallbacks', () => {
    // SOCKS is recognized but undici cannot speak it — the next usable entry wins.
    expect(proxyUrlFromResolution('SOCKS5 127.0.0.1:1080; PROXY 127.0.0.1:7897; DIRECT')).toBe(
      'http://127.0.0.1:7897'
    )
    expect(proxyUrlFromResolution('SOCKS5 127.0.0.1:1080; DIRECT')).toBeNull()
  })

  it('returns null for DIRECT and malformed entries', () => {
    expect(proxyUrlFromResolution('DIRECT')).toBeNull()
    expect(proxyUrlFromResolution('PROXY')).toBeNull()
    expect(proxyUrlFromResolution('')).toBeNull()
  })
})

describe('DispatcherPool cache/close semantics', () => {
  it('caches one dispatcher per key and closes agents on closeAll', async () => {
    const pool = new DispatcherPool()
    const a = pool.acquire('manual:http://127.0.0.1:1', () => new ProxyAgent('http://127.0.0.1:1'))
    const a2 = pool.acquire('manual:http://127.0.0.1:1', () => new ProxyAgent('http://127.0.0.1:1'))
    const b = pool.acquire('direct', () => new Agent())
    expect(a).toBe(a2)
    expect(b).not.toBe(a)
    expect(pool.keys().sort()).toEqual(['direct', 'manual:http://127.0.0.1:1'])

    await pool.closeAll()
    expect(pool.keys()).toEqual([])
  })
})

describe('createTaskFetch per-snapshot routes (real local fixtures)', () => {
  let origin: Awaited<ReturnType<typeof startOriginServer>>
  let proxy: Awaited<ReturnType<typeof startRecordingProxy>>
  const serverRoots: Array<() => Promise<void>> = []

  beforeEach(async () => {
    origin = await startOriginServer('transport-fixture')
    proxy = await startRecordingProxy()
    serverRoots.push(
      () => origin.close(),
      () => proxy.close()
    )
  })

  afterEach(async () => {
    for (const close of serverRoots.splice(0)) await close().catch(() => undefined)
  })

  function expectTunneledThroughProxy(): void {
    // undici ProxyAgent tunnels every request (CONNECT), even to http origins.
    const connects = proxy.requests.filter((r) => r.method === 'CONNECT')
    expect(connects.length).toBeGreaterThan(0)
    expect(connects.some((r) => r.url.includes(new URL(origin.url).port))).toBe(true)
  }

  it('Manual: request flows through the recording proxy, origin only sees the forward', async () => {
    const pool = new DispatcherPool()
    const { fetchImpl } = createTaskFetch({ mode: 'manual', url: proxy.url }, { pool })
    const res = await fetchImpl(`${origin.url}/weights.bin`)
    expect(await res.text()).toBe('transport-fixture')
    expectTunneledThroughProxy()
    // origin was reached only via the proxy forward
    expect(origin.requests.some((r) => r.url.includes('/weights.bin'))).toBe(true)
    await pool.closeAll()
  })

  it('Direct: bypasses the recording proxy entirely and hits the origin directly', async () => {
    const pool = new DispatcherPool()
    const { fetchImpl } = createTaskFetch(DIRECT, { pool })
    const res = await fetchImpl(`${origin.url}/direct.bin`)
    expect(await res.text()).toBe('transport-fixture')
    expect(origin.requests.length).toBe(1)
    expect(proxy.requests.length).toBe(0)
    await pool.closeAll()
  })

  it('System: resolves the OS route at request execution and uses the translated proxy', async () => {
    const pool = new DispatcherPool()
    // Raw PAC-style resolution translated by the same ordered-PROXY/HTTPS/SOCKS/DIRECT
    // translation the app applies to session.resolveProxy output.
    const resolver = vi.fn(
      async () => proxyUrlFromResolution(`PROXY ${new URL(proxy.url).host}; DIRECT`) ?? null
    )
    const { fetchImpl } = createTaskFetch(SYSTEM, { pool, resolver })
    const res = await fetchImpl(`${origin.url}/system.bin`)
    expect(await res.text()).toBe('transport-fixture')
    expect(resolver).toHaveBeenCalledWith(`${origin.url}/system.bin`)
    expectTunneledThroughProxy()
    expect(origin.requests.some((r) => r.url.includes('/system.bin'))).toBe(true)
    await pool.closeAll()
  })

  it('System: a DIRECT resolution falls back to the explicit direct agent', async () => {
    const pool = new DispatcherPool()
    const { fetchImpl } = createTaskFetch(SYSTEM, { pool, resolver: async () => 'DIRECT' })
    const res = await fetchImpl(`${origin.url}/direct-resolution.bin`)
    expect(await res.text()).toBe('transport-fixture')
    expect(origin.requests.length).toBe(1)
    expect(proxy.requests.length).toBe(0)
    await pool.closeAll()
  })

  it('System: a failed resolver degrades to direct instead of surfacing a proxy error', async () => {
    const pool = new DispatcherPool()
    const { fetchImpl } = createTaskFetch(SYSTEM, {
      pool,
      resolver: async () => {
        throw new Error('proxy service unavailable')
      }
    })
    const res = await fetchImpl(`${origin.url}/degraded.bin`)
    expect(await res.text()).toBe('transport-fixture')
    expect(proxy.requests.length).toBe(0)
    await pool.closeAll()
  })
})

describe('transport isolation: per-task sessions + global state', () => {
  it('assigns one dedicated session partition per task so snapshots never share Chromium state', async () => {
    const manager = new ProxyTransportManager()
    const t1 = manager.transportFor('task-a', MANUAL)
    const t2 = manager.transportFor('task-b', SYSTEM)
    const t3 = manager.transportFor('task-c', DIRECT)

    expect(t1.partition).toBe('persist:hubfetch-task-task-a')
    expect(t1.partition).toMatch(new RegExp(`^${TASK_PARTITION_PREFIX}task-a$`))
    expect(t2.partition).toBe('persist:hubfetch-task-task-b')
    expect(t3.partition).toBe('persist:hubfetch-task-task-c')
    expect(new Set([t1.ses, t2.ses, t3.ses]).size).toBe(3)

    expect(electronMocks.sessions.get(t1.partition)!.setProxy).toHaveBeenCalledWith({
      proxyRules: 'http://127.0.0.1:7897'
    })
    expect(electronMocks.sessions.get(t2.partition)!.setProxy).toHaveBeenCalledWith({
      mode: 'system'
    })
    expect(electronMocks.sessions.get(t3.partition)!.setProxy).toHaveBeenCalledWith({
      mode: 'direct'
    })

    await manager.closeAll()
    expect(electronMocks.sessions.get(t1.partition)!.closeAllConnections).toHaveBeenCalled()
  })

  it('reuses the session for the same task id and releases it on closeTask', async () => {
    const manager = new ProxyTransportManager()
    const first = manager.transportFor('task-a', MANUAL)
    const again = manager.transportFor('task-a', MANUAL)
    expect(first.ses).toBe(again.ses)

    await manager.closeTask('task-a')
    const fresh = manager.transportFor('task-a', MANUAL)
    expect(fresh.ses).toBe(first.ses) // partition cached by Electron; manager reuse is by task id
    await manager.closeAll()
  })

  it('never mutates the global undici dispatcher and leaves the parent env untouched', async () => {
    const beforeDispatcher = getGlobalDispatcher()
    const beforeEnv = { ...process.env }
    const pool = new DispatcherPool()
    // Port 9 (discard) refuses connections — the point is that the fetch
    // machinery runs without touching the global dispatcher or the parent env.
    await createTaskFetch(MANUAL, { pool })
      .fetchImpl('http://127.0.0.1:9/x')
      .catch(() => undefined)
    await createTaskFetch(DIRECT, { pool })
      .fetchImpl('http://127.0.0.1:9/y')
      .catch(() => undefined)
    await createTaskFetch(SYSTEM, { pool, resolver: async () => 'DIRECT' })
      .fetchImpl('http://127.0.0.1:9/z')
      .catch(() => undefined)

    expect(getGlobalDispatcher()).toBe(beforeDispatcher)
    expect(process.env).toEqual(beforeEnv)
    await pool.closeAll()
  })

  it('system resolution for a task flows through ITS OWN session.resolveProxy', async () => {
    const manager = new ProxyTransportManager()
    const t = manager.transportFor('task-sys', SYSTEM)
    const partition = electronMocks.sessions.get(t.partition)!
    partition.resolveProxy.mockImplementation(async () => 'PROXY 127.0.0.1:9090; DIRECT')
    expect(await t.resolveProxyFor('https://huggingface.co/foo')).toBe('http://127.0.0.1:9090')
    expect(partition.resolveProxy).toHaveBeenCalledWith('https://huggingface.co/foo')
    await manager.closeAll()
  })

  it('manual/direct tasks answer resolveProxyFor with their own policy', async () => {
    const manager = new ProxyTransportManager()
    const manual = manager.transportFor('task-m', MANUAL)
    const direct = manager.transportFor('task-d', DIRECT)
    expect(await manual.resolveProxyFor('https://huggingface.co/x')).toBe('http://127.0.0.1:7897')
    expect(await direct.resolveProxyFor('https://huggingface.co/x')).toBeNull()
    await manager.closeAll()
  })
})
