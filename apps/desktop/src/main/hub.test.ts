import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolution: 'DIRECT',
  setProxy: vi.fn(async () => undefined),
  resolveProxy: vi.fn(async () => 'DIRECT'),
  fetchCalls: [] as Array<{ input: unknown; init: Record<string, unknown> | undefined }>,
  agentCtor: vi.fn(),
  proxyAgentCtor: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  session: {
    fromPartition: () => ({
      setProxy: mocks.setProxy,
      resolveProxy: mocks.resolveProxy
    })
  }
}))

vi.mock('undici', () => ({
  Agent: class {
    constructor(...args: unknown[]) {
      mocks.agentCtor(...args)
    }
  },
  ProxyAgent: class {
    readonly uri: string

    constructor(uri: string) {
      mocks.proxyAgentCtor(uri)
      this.uri = uri
    }
  },
  fetch: async (input: unknown, init: Record<string, unknown> | undefined) => {
    mocks.fetchCalls.push({ input, init })
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
  }
}))

import { createProxiedFetch, proxyUrlFromResolution, resolveSystemProxyUrl } from './hub'

describe('Hub system proxy transport', () => {
  beforeEach(() => {
    mocks.resolution = 'DIRECT'
    mocks.setProxy.mockClear()
    mocks.resolveProxy.mockReset()
    mocks.resolveProxy.mockImplementation(async () => mocks.resolution)
    mocks.fetchCalls.length = 0
    mocks.agentCtor.mockClear()
    mocks.proxyAgentCtor.mockClear()
  })

  it('parses Chromium HTTP(S) proxy resolution strings', () => {
    expect(proxyUrlFromResolution('PROXY 127.0.0.1:6152')).toBe('http://127.0.0.1:6152')
    expect(proxyUrlFromResolution('HTTPS proxy.example:8443; DIRECT')).toBe(
      'https://proxy.example:8443'
    )
    expect(proxyUrlFromResolution('SOCKS5 127.0.0.1:1080; DIRECT')).toBeNull()
    expect(proxyUrlFromResolution('DIRECT')).toBeNull()
  })

  it('routes a System snapshot through the resolved system proxy', async () => {
    mocks.resolution = 'PROXY 127.0.0.1:6152'
    const fetchImpl = createProxiedFetch({ mode: 'system' })

    await fetchImpl('https://huggingface.co/api/models?limit=1')

    expect(mocks.setProxy).toHaveBeenCalledWith({ mode: 'system' })
    expect(mocks.resolveProxy).toHaveBeenCalledWith('https://huggingface.co/api/models?limit=1')
    expect((mocks.fetchCalls[0]?.init?.dispatcher as { uri?: string } | undefined)?.uri).toBe(
      'http://127.0.0.1:6152'
    )
  })

  it('keeps a Manual snapshot ahead of the system resolver', async () => {
    const resolver = vi.fn(async () => 'PROXY 127.0.0.1:9999')
    const fetchImpl = createProxiedFetch(
      { mode: 'manual', url: 'http://127.0.0.1:7890' },
      {
        resolver
      }
    )

    await fetchImpl('https://huggingface.co/api/models?limit=1')

    expect(resolver).not.toHaveBeenCalled()
    expect((mocks.fetchCalls[0]?.init?.dispatcher as { uri?: string } | undefined)?.uri).toBe(
      'http://127.0.0.1:7890'
    )
  })

  it('Direct snapshot uses the explicit direct agent and never consults the resolver', async () => {
    const resolver = vi.fn(async () => 'PROXY 127.0.0.1:9999')
    const fetchImpl = createProxiedFetch({ mode: 'direct' }, { resolver })

    await fetchImpl('https://huggingface.co/api/models?limit=1')

    expect(resolver).not.toHaveBeenCalled()
    const dispatcher = mocks.fetchCalls[0]?.init?.dispatcher as { uri?: string } | undefined
    expect(dispatcher).toBeDefined()
    expect(dispatcher?.uri).toBeUndefined() // an Agent, not a ProxyAgent
  })

  it('falls back to direct when the OS reports DIRECT or resolution fails', async () => {
    expect(await resolveSystemProxyUrl('https://huggingface.co', async () => 'DIRECT')).toBeNull()
    expect(
      await resolveSystemProxyUrl('https://huggingface.co', async () => {
        throw new Error('proxy service unavailable')
      })
    ).toBeNull()

    const fetchImpl = createProxiedFetch(
      { mode: 'system' },
      {
        resolver: async () => 'DIRECT'
      }
    )
    await fetchImpl('https://huggingface.co/api/models?limit=1')
    const dispatcher = mocks.fetchCalls[0]?.init?.dispatcher as { uri?: string } | undefined
    expect(dispatcher).toBeDefined()
    expect(dispatcher?.uri).toBeUndefined()
  })
})
