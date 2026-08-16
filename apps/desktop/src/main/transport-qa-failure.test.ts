/**
 * QA failure path: environment AND system/PAC proxy configured to a TRAP.
 * While selecting Direct, ANY trap hit fails the test while the direct origin
 * succeeds; the System path (contrast) is shown hitting the trap as expected.
 * Also proves the git contract strips proxy env for Direct children only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTaskFetch } from './transport'
import { proxyUrlFromResolution } from './transport'
import { createWorkerTransport } from './workers/download-worker'
import { gitProxyContract, PROXY_ENV_KEYS } from './git-proxy'
import { startOriginServer, startRecordingProxy } from './test/proxy-fixtures'

const ORIGIN_BODY = 'qa-failure-body'

describe('QA failure — Direct must never touch a configured trap', () => {
  let origin: Awaited<ReturnType<typeof startOriginServer>>
  let trap: Awaited<ReturnType<typeof startRecordingProxy>>
  const roots: Array<() => Promise<void>> = []
  const previousEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    origin = await startOriginServer(ORIGIN_BODY)
    trap = await startRecordingProxy()
    roots.push(
      () => origin.close(),
      () => trap.close()
    )
    // Configure the environment to point straight at the trap.
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy'
    ]) {
      previousEnv[key] = process.env[key]
      process.env[key] = trap.url
    }
  })

  afterEach(async () => {
    for (const key of Object.keys(previousEnv)) {
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
    for (const close of roots.splice(0)) await close().catch(() => undefined)
  })

  const log = (label: string, value: unknown): void => {
    console.log(`[qa-failure] ${label}: ${JSON.stringify(value)}`)
  }

  it('Direct hub-api fetch succeeds on the origin and NEVER hits the trap', async () => {
    const { fetchImpl } = createTaskFetch({ mode: 'direct' })
    const res = await fetchImpl(`${origin.url}/direct.bin`)
    const text = await res.text()
    log('direct-hub/body', text)
    log('direct-hub/trap.requests', trap.requests)
    log('direct-hub/origin.requests', origin.requests)
    expect(text).toBe(ORIGIN_BODY)
    // The trap must be silent — any hit here FAILS the test.
    expect(trap.requests.length).toBe(0)
    expect(origin.requests.length).toBe(1)
  })

  it('Direct worker fetch succeeds on the origin and NEVER hits the trap', async () => {
    const transport = createWorkerTransport({ mode: 'direct' })
    try {
      const res = await transport.httpFetch(`${origin.url}/worker-direct.bin`)
      const text = await res.text()
      log('direct-worker/body', text)
      log('direct-worker/trap.requests', trap.requests)
      log('direct-worker/origin.requests', origin.requests)
      expect(text).toBe(ORIGIN_BODY)
      expect(trap.requests.length).toBe(0)
      expect(origin.requests.length).toBe(1)
    } finally {
      await transport.close()
    }
  })

  it('Direct never relies on env variables, even a system/PAC resolution to the trap', async () => {
    const { fetchImpl } = createTaskFetch({ mode: 'direct' })
    const trapPac = `PROXY ${new URL(trap.url).host}; DIRECT`
    // A system/PAC resolver (simulated OS config) ALSO points at the trap.
    const systemFetch = createTaskFetch(
      { mode: 'system' },
      { resolver: async () => proxyUrlFromResolution(trapPac) }
    )
    const systemRes = await systemFetch.fetchImpl(`${origin.url}/system-vs-trap.bin`)
    log('contrast/system/body', await systemRes.text())
    log('contrast/system/trap.requests', trap.requests)
    // Contrast: System honors the trap (expected). Now Direct with the SAME env.
    const before = trap.requests.length
    const directRes = await fetchImpl(`${origin.url}/direct-vs-trap.bin`)
    const text = await directRes.text()
    log('contrast/direct/body', text)
    log('contrast/direct/trap.requests-after', trap.requests.slice(before))
    expect(text).toBe(ORIGIN_BODY)
    expect(trap.requests.length).toBe(before) // Direct added nothing to the trap
  })

  it('git Direct contract strips proxy vars from the child env; parent env untouched', async () => {
    const base = { ...process.env, PATH: 'C:\\bin' }
    const contract = gitProxyContract({ mode: 'direct' }, base)
    log('git/direct/argv', contract.argv)
    log(
      'git/direct/stripped',
      PROXY_ENV_KEYS.filter((k) => !(k in contract.env))
    )
    for (const key of PROXY_ENV_KEYS) expect(contract.env).not.toHaveProperty(key)
    // Parent env (this process) still points at the trap — untouched.
    expect(process.env.HTTP_PROXY).toBe(trap.url)
    log('git/direct/parent-http-proxy-untouched', process.env.HTTP_PROXY)

    // Manual/System pass the parent env through (no stripping).
    const manualContract = gitProxyContract({ mode: 'manual', url: trap.url }, base)
    expect(manualContract.env).toEqual(base)
    const systemContract = gitProxyContract({ mode: 'system' }, base)
    expect(systemContract.argv).toEqual([])
  })
})
