import { app, session, type Session } from 'electron'
import { HubClient } from '@hubfetch/hub-api'
import type { ProxyConfig, ProxySnapshot } from '@hubfetch/shared'
import { createTaskFetch, proxyUrlFromResolution, type ProxyResolver } from './transport'

export { proxyUrlFromResolution } from './transport'

export interface HubHolder {
  current: HubClient
}

const SYSTEM_PROXY_PARTITION = 'hubfetch-system-proxy'
let systemProxySessionPromise: Promise<Session> | null = null

async function systemProxySession(): Promise<Session> {
  if (!systemProxySessionPromise) {
    const ses = session.fromPartition(SYSTEM_PROXY_PARTITION, { cache: false })
    systemProxySessionPromise = ses.setProxy({ mode: 'system' }).then(() => ses)
    systemProxySessionPromise.catch(() => {
      systemProxySessionPromise = null
    })
  }
  return systemProxySessionPromise
}

async function resolveSystemProxy(url: string): Promise<string> {
  return (await systemProxySession()).resolveProxy(url)
}

/** Resolve the current OS HTTP(S) proxy for a URL; null means direct/unsupported. */
export async function resolveSystemProxyUrl(
  url: string,
  resolver: ProxyResolver = resolveSystemProxy
): Promise<string | null> {
  try {
    return proxyUrlFromResolution(await resolver(url))
  } catch {
    // Preserve direct networking if Chromium cannot initialize its proxy service.
    return null
  }
}

/**
 * Node fetch does not inherit Chromium/macOS proxy settings. Build a
 * snapshot-aware fetch: System resolves the OS route per request, Manual pins
 * an Undici ProxyAgent, Direct uses an explicit direct Agent. Dispatchers are
 * injected per fetch — never installed process-globally.
 */
export function createProxiedFetch(
  snapshot: ProxySnapshot,
  opts: { resolver?: ProxyResolver } = {}
): typeof fetch {
  const taskFetch = createTaskFetch(snapshot, {
    resolver: (url: string) => resolveSystemProxyUrl(url, opts.resolver ?? resolveSystemProxy)
  })
  return taskFetch.fetchImpl
}

export interface HubNetworkOptions {
  endpoint: string | null
  proxy: ProxySnapshot
}

/** Endpoint + proxy snapshot last applied to the app HubClient — startup and
 * settings rebuilds both funnel through `createHubClient`. SDK-based
 * integrations (upload, inference playground) read this so their traffic rides
 * the same network path instead of the SDKs' global unproxied fetch. */
let networkOptions: HubNetworkOptions = { endpoint: null, proxy: { mode: 'system' } }

export function getHubNetworkOptions(): HubNetworkOptions {
  return networkOptions
}

/** Map the persisted settings ProxyConfig to a closed snapshot. */
export function snapshotFromConfig(config: ProxyConfig): ProxySnapshot {
  switch (config.mode) {
    case 'system':
      return { mode: 'system' }
    case 'direct':
      return { mode: 'direct' }
    case 'manual':
      return config.manualUrl ? { mode: 'manual', url: config.manualUrl } : { mode: 'system' }
  }
}

export function createHubClient(
  getAccessToken: () => string | undefined,
  getSessionCookie: () => string | undefined,
  options?: { endpoint?: string | null; proxy?: ProxySnapshot }
): HubClient {
  networkOptions = {
    endpoint: options?.endpoint ?? null,
    proxy: options?.proxy ?? { mode: 'system' }
  }
  return buildHubClient(getAccessToken, getSessionCookie, options)
}

/**
 * Pure client factory: builds for the given endpoint/proxy WITHOUT recording
 * them as the applied network options — for throwaway clients such as the
 * Settings → Network "Test connection" probe against draft values.
 */
export function buildHubClient(
  getAccessToken: () => string | undefined,
  getSessionCookie: () => string | undefined,
  options?: { endpoint?: string | null; proxy?: ProxySnapshot }
): HubClient {
  return new HubClient({
    endpoint: options?.endpoint ?? undefined,
    fetchImpl: createProxiedFetch(options?.proxy ?? { mode: 'system' }),
    userAgent: `HubFetch/${app.getVersion()} (unofficial desktop client; +https://github.com/OranImp/HubFetch)`,
    cacheTtlMs: 120_000,
    // Desktop browsing bursts (grids, file trees) get smoothed out instead of tripping
    // the Hub's per-IP rate limits: few sockets, spaced starts, a couple of retries.
    maxConcurrent: 4,
    minRequestGapMs: 120,
    maxRetries: 2,
    getAccessToken,
    getSessionCookie
  })
}

/**
 * Stable HubClient-shaped proxy so DownloadManager / FollowsPoller / IPC keep working
 * after endpoint or proxy rebuilds replace `holder.current`.
 */
export function createHubProxy(holder: HubHolder): HubClient {
  return new Proxy({} as HubClient, {
    get(_target, prop, _receiver) {
      const value = Reflect.get(holder.current, prop, holder.current) as unknown
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(holder.current)
      }
      return value
    }
  })
}

export function rebuildHubClient(
  holder: HubHolder,
  getAccessToken: () => string | undefined,
  getSessionCookie: () => string | undefined,
  options: { endpoint: string | null; proxy: ProxySnapshot }
): void {
  holder.current = createHubClient(getAccessToken, getSessionCookie, options)
}
