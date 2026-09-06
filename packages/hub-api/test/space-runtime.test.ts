import { describe, expect, it, vi } from 'vitest'
import { HubClient } from '../src'

/**
 * Wire-level contract tests for the Space lifecycle endpoints (Todo 21):
 * exact methods/paths/query/body, token auth, no retry of mutations, additive
 * runtime parsing, and typed error outcomes.
 */

const RUNTIME = {
  stage: 'RUNNING',
  hardware: 'cpu-basic',
  requestedHardware: null,
  gcTimeout: null,
  sleepTime: null,
  storage: null,
  devMode: null,
  // Additive unknown fields must be tolerated.
  replicas: 1,
  sdk: 'gradio',
  someFutureField: { nested: true }
}

const CATALOG = [
  {
    name: 'cpu-basic',
    prettyName: 'CPU Basic',
    cpu: '2 vCPU',
    ram: '16 GB',
    accelerator: null,
    unitCostMicroUSD: 0,
    unitCostUSD: 0,
    unitLabel: 'hour'
  },
  {
    name: 'a10g-small',
    prettyName: 'Nvidia A10G small',
    cpu: '4 vCPU',
    ram: '15 GB',
    accelerator: {
      type: 'gpu',
      model: 'A10G',
      quantity: '1',
      vram: '24GB',
      manufacturer: 'Nvidia'
    },
    unitCostMicroUSD: 1000,
    unitCostUSD: 1,
    unitLabel: 'hour'
  }
]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const FAST = { cacheTtlMs: 0, minRequestGapMs: 0 } as const
const TOKEN = { getAccessToken: () => 'hf_lifecycle_token' } as const

function requestOf(
  fetchImpl: ReturnType<typeof vi.fn>,
  call = 0
): { url: string; init: RequestInit } {
  return {
    url: fetchImpl.mock.calls[call]![0] as string,
    init: (fetchImpl.mock.calls[call]![1] ?? {}) as RequestInit
  }
}

function jsonBodyOf(init: RequestInit): unknown {
  return JSON.parse(init.body as string)
}

describe('HubClient.getSpaceRuntime', () => {
  it('GETs the runtime with token auth and maps every known field', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(RUNTIME))
    const client = new HubClient({ fetchImpl, ...FAST, ...TOKEN })

    const runtime = await client.getSpaceRuntime('a/b')

    expect(requestOf(fetchImpl).url).toBe('https://huggingface.co/api/spaces/a/b/runtime')
    expect(requestOf(fetchImpl).init.method).toBeUndefined()
    const headers = requestOf(fetchImpl).init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer hf_lifecycle_token')
    expect(runtime).toEqual({
      stage: 'RUNNING',
      hardware: 'cpu-basic',
      requestedHardware: null,
      gcTimeout: null,
      sleepTime: null,
      storage: null,
      devMode: null
    })
  })

  it('keeps parsing when the response carries additive unknown fields and nulls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        stage: 'SLEEPING',
        hardware: 'cpu-upgrade',
        requestedHardware: 'cpu-upgrade',
        gcTimeout: 172800,
        sleepTime: 172800,
        unknownAddition: 'x'
      })
    )
    const client = new HubClient({ fetchImpl, ...FAST })
    const runtime = await client.getSpaceRuntime('a/b')
    expect(runtime.stage).toBe('SLEEPING')
    expect(runtime.hardware).toBe('cpu-upgrade')
    expect(runtime.gcTimeout).toBe(172800)
    expect(runtime.sleepTime).toBe(172800)
    expect(runtime.storage).toBeNull()
    expect(runtime.devMode).toBeNull()
  })

  it('rejects a runtime response missing the semantic stage field', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ hardware: 'cpu-basic' }))
    const client = new HubClient({ fetchImpl, ...FAST })
    await expect(client.getSpaceRuntime('a/b')).rejects.toMatchObject({
      name: 'HubApiError',
      message: expect.stringContaining('malformed')
    })
  })

  it('rejects a non-object runtime response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(['nope']))
    const client = new HubClient({ fetchImpl, ...FAST })
    await expect(client.getSpaceRuntime('a/b')).rejects.toMatchObject({
      name: 'HubApiError',
      message: expect.stringContaining('malformed')
    })
  })
})

describe('HubClient.listSpaceHardware', () => {
  it('GETs the public catalog without auth requirements and strips cost fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(CATALOG))
    const client = new HubClient({ fetchImpl, ...FAST })

    const catalog = await client.listSpaceHardware()

    expect(requestOf(fetchImpl).url).toBe('https://huggingface.co/api/spaces/hardware')
    expect(catalog).toEqual([
      {
        name: 'cpu-basic',
        prettyName: 'CPU Basic',
        cpu: '2 vCPU',
        ram: '16 GB',
        accelerator: null
      },
      {
        name: 'a10g-small',
        prettyName: 'Nvidia A10G small',
        cpu: '4 vCPU',
        ram: '15 GB',
        accelerator: 'A10G 24GB x1'
      }
    ])
    // No pricing field may survive mapping.
    for (const entry of catalog) {
      expect(Object.keys(entry).some((key) => /cost|price|usd/i.test(key))).toBe(false)
    }
  })

  it('rejects a malformed catalog payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ not: 'an array' }))
    const client = new HubClient({ fetchImpl, ...FAST })
    await expect(client.listSpaceHardware()).rejects.toMatchObject({
      name: 'HubApiError',
      message: expect.stringContaining('malformed')
    })
  })
})

describe('HubClient.pauseSpace', () => {
  it('POSTs to the pause endpoint with token auth and no body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    const client = new HubClient({ fetchImpl, ...FAST, ...TOKEN })

    await client.pauseSpace('a/b')

    const { url, init } = requestOf(fetchImpl)
    expect(url).toBe('https://huggingface.co/api/spaces/a/b/pause')
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer hf_lifecycle_token')
  })

  it('never retries a paused mutation on retryable-looking 503/500 responses', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 503 }))
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
    const client = new HubClient({ fetchImpl, ...FAST, maxRetries: 2 })
    await expect(client.pauseSpace('a/b')).rejects.toMatchObject({
      name: 'HubApiError',
      status: 503
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const fetchImpl500 = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))
    const client500 = new HubClient({ fetchImpl: fetchImpl500, ...FAST, maxRetries: 2 })
    await expect(client500.pauseSpace('a/b')).rejects.toMatchObject({ status: 500 })
    expect(fetchImpl500).toHaveBeenCalledTimes(1)
  })
})

describe('HubClient.requestSpaceHardware', () => {
  it('POSTs the exact official body for a paid flavor with sleep seconds', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    const client = new HubClient({ fetchImpl, ...FAST, ...TOKEN })

    await client.requestSpaceHardware('a/b', 'cpu-upgrade', 7200)

    const { url, init } = requestOf(fetchImpl)
    expect(url).toBe('https://huggingface.co/api/spaces/a/b/hardware')
    expect(init.method).toBe('POST')
    expect(jsonBodyOf(init)).toEqual({ flavor: 'cpu-upgrade', sleepTimeSeconds: 7200 })
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer hf_lifecycle_token')
  })

  it('omits sleepTimeSeconds when not requested', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    const client = new HubClient({ fetchImpl, ...FAST })
    await client.requestSpaceHardware('a/b', 'cpu-basic')
    expect(jsonBodyOf(requestOf(fetchImpl).init)).toEqual({ flavor: 'cpu-basic' })
  })

  it('accepts -1 as never-sleep where the API permits it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    const client = new HubClient({ fetchImpl, ...FAST })
    await client.requestSpaceHardware('a/b', 'cpu-upgrade', -1)
    expect(jsonBodyOf(requestOf(fetchImpl).init)).toEqual({
      flavor: 'cpu-upgrade',
      sleepTimeSeconds: -1
    })
  })

  it('rejects non-official sleep values before any network I/O', async () => {
    const fetchImpl = vi.fn()
    const client = new HubClient({ fetchImpl, ...FAST })
    await expect(client.requestSpaceHardware('a/b', 'cpu-upgrade', 0)).rejects.toThrow(
      /sleepTimeSeconds/
    )
    await expect(client.requestSpaceHardware('a/b', 'cpu-upgrade', 1.5)).rejects.toThrow(
      /sleepTimeSeconds/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('HubClient.setSpaceSleepTime', () => {
  it('POSTs {seconds} to the sleeptime endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    const client = new HubClient({ fetchImpl, ...FAST, ...TOKEN })

    await client.setSpaceSleepTime('a/b', 3600)

    const { url, init } = requestOf(fetchImpl)
    expect(url).toBe('https://huggingface.co/api/spaces/a/b/sleeptime')
    expect(init.method).toBe('POST')
    expect(jsonBodyOf(init)).toEqual({ seconds: 3600 })
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer hf_lifecycle_token')
  })

  it('POSTs -1 for never-sleep and rejects invalid values before I/O', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    const client = new HubClient({ fetchImpl, ...FAST })
    await client.setSpaceSleepTime('a/b', -1)
    expect(jsonBodyOf(requestOf(fetchImpl).init)).toEqual({ seconds: -1 })

    const noNetwork = vi.fn()
    const client2 = new HubClient({ fetchImpl: noNetwork, ...FAST })
    await expect(client2.setSpaceSleepTime('a/b', 0)).rejects.toThrow(/seconds/)
    expect(noNetwork).not.toHaveBeenCalled()
  })
})

describe('HubClient space lifecycle typed error outcomes', () => {
  it.each([400, 401, 403, 404, 409, 429])(
    'maps a %d runtime read to HubApiError',
    async (status) => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response('no', { status }))
      const client = new HubClient({ fetchImpl, ...FAST, maxRetries: 0 })
      await expect(client.getSpaceRuntime('a/b')).rejects.toMatchObject({
        name: 'HubApiError',
        status
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it.each([400, 401, 403, 404, 409, 429, 500])(
    'maps a %d pause mutation to HubApiError with a single request',
    async (status) => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response('no', { status }))
      const client = new HubClient({ fetchImpl, ...FAST, maxRetries: 0 })
      await expect(client.pauseSpace('a/b')).rejects.toMatchObject({
        name: 'HubApiError',
        status
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it('maps a 5xx runtime failure to HubApiError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 502 }))
    const client = new HubClient({ fetchImpl, ...FAST, maxRetries: 0 })
    await expect(client.getSpaceRuntime('a/b')).rejects.toMatchObject({
      name: 'HubApiError',
      status: 502
    })
  })

  it('surfaces network failures as thrown fetch errors', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const client = new HubClient({ fetchImpl, ...FAST, maxRetries: 0 })
    await expect(client.getSpaceRuntime('a/b')).rejects.toThrow('fetch failed')
    await expect(client.pauseSpace('a/b')).rejects.toThrow('fetch failed')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
