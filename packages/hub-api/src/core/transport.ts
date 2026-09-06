import { CookieRequiredError } from '../errors'
import {
  HubEndpointPolicy,
  type AuthHeaderOptions,
  type AuthMode,
  formatSessionCookie
} from './endpoint-auth'
import { GetCache, type CachedJson } from './cache'
import {
  buildJsonRequest,
  cookiePairsFromResponse,
  readBodyCapped,
  totalSizeFrom,
  type JsonMethod
} from './request'
import { RetryPolicy, isTransientFailure } from './retry'
import { ensureResponseOk } from './response'
import { RequestScheduler } from './scheduler'

const DEFAULT_RETRY_STATUSES = [429, 503] as const

export interface HubTransportOptions {
  readonly endpoint: string
  readonly userAgent: string
  readonly fetchImpl: typeof fetch
  readonly cacheTtlMs: number
  readonly maxConcurrent: number
  readonly minRequestGapMs: number
  readonly maxRetries: number
  readonly getAccessToken: () => string | undefined
  readonly getSessionCookie: () => string | undefined
}

export interface TransportRequestOptions extends AuthHeaderOptions {
  readonly auth?: AuthMode
  readonly retryStatuses?: readonly number[]
}

export class HubTransport {
  readonly endpoint: string
  private readonly policy: HubEndpointPolicy
  private readonly userAgent: string
  private readonly fetchImpl: typeof fetch
  private readonly cacheTtlMs: number
  private readonly cache: GetCache
  private readonly scheduler: RequestScheduler
  private readonly retry: RetryPolicy
  private readonly getAccessToken: () => string | undefined
  private readonly getSessionCookie: () => string | undefined

  constructor(options: HubTransportOptions) {
    this.policy = new HubEndpointPolicy(options.endpoint)
    this.endpoint = this.policy.endpoint
    this.userAgent = options.userAgent
    this.fetchImpl = options.fetchImpl
    this.cacheTtlMs = options.cacheTtlMs
    this.cache = new GetCache(options.getAccessToken)
    this.scheduler = new RequestScheduler(options.maxConcurrent, options.minRequestGapMs)
    this.retry = new RetryPolicy(options.maxRetries)
    this.getAccessToken = options.getAccessToken
    this.getSessionCookie = options.getSessionCookie
  }

  hasSessionCookie(): boolean {
    return Boolean(this.getSessionCookie())
  }

  sessionCookie(): string | undefined {
    return this.getSessionCookie()
  }

  requireCookie(url: string): void {
    const cookie = this.getSessionCookie()
    if (!cookie || !this.policy.allowsAuth(url)) throw new CookieRequiredError(url)
  }

  invalidateCache(): void {
    this.cache.clear()
  }

  async request(
    url: string,
    init: RequestInit = {},
    options: TransportRequestOptions = {}
  ): Promise<Response> {
    const auth = options.auth ?? 'token'
    const headers = {
      ...this.additionalHeaders(init.headers),
      ...this.authHeaders(url, auth, options)
    }
    const requestInit = { ...init, headers }
    return this.fetchWithPolicy(url, requestInit, options.retryStatuses ?? DEFAULT_RETRY_STATUSES)
  }

  async ensureOk(response: Response, method: string, url: string): Promise<void> {
    await ensureResponseOk(response, method, url)
  }

  async sendJson(
    method: JsonMethod,
    url: string,
    body?: unknown,
    options: { readonly auth?: AuthMode } = {}
  ): Promise<Response> {
    const res = await this.request(url, buildJsonRequest(method, body, {}), {
      auth: options.auth,
      retryStatuses: [429]
    })
    await this.ensureOk(res, method, url)
    this.invalidateCache()
    return res
  }

  async getJson<T>(url: string, options: { readonly ttl?: number } = {}): Promise<CachedJson<T>> {
    const ttl = options.ttl ?? this.cacheTtlMs
    const key = this.cache.key(url)
    const hit = this.cache.fresh<T>(key, ttl)
    if (hit) return hit
    return this.cache.coalesce(`json:${key}`, async () => {
      try {
        const res = await this.request(url)
        await this.ensureOk(res, 'GET', url)
        const body = (await res.json()) as T
        const nextUrl = this.parseLinkNext(res.headers.get('Link'))
        if (ttl > 0) this.cache.set(key, { at: Date.now(), status: res.status, body, nextUrl })
        return { body, nextUrl }
      } catch (error) {
        const stale = this.cache.stale(key)
        if (stale && isTransientFailure(error)) {
          return { body: stale.body as T, nextUrl: stale.nextUrl }
        }
        throw error
      }
    })
  }

  async getText(url: string): Promise<string> {
    const key = this.cache.key(url)
    const hit = this.cache.fresh<string>(key, this.cacheTtlMs)
    if (hit) return hit.body
    return this.cache.coalesce(`text:${key}`, async () => {
      try {
        const res = await this.request(url)
        await this.ensureOk(res, 'GET', url)
        const body = await res.text()
        if (this.cacheTtlMs > 0) this.cache.set(key, { at: Date.now(), status: res.status, body })
        return body
      } catch (error) {
        const stale = this.cache.stale(key)
        if (stale && isTransientFailure(error)) return stale.body as string
        throw error
      }
    })
  }

  async fetchRange(url: string, start: number, end: number): Promise<Uint8Array> {
    const res = await this.request(url, {
      headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' }
    })
    if (res.status !== 200 && res.status !== 206) await this.ensureOk(res, 'GET', url)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const want = end - start + 1
    return res.status === 200 && bytes.byteLength > want ? bytes.slice(start, end + 1) : bytes
  }

  readBodyCapped(
    response: Response,
    maxBytes: number
  ): Promise<{ bytes: Uint8Array; capped: boolean }> {
    return readBodyCapped(response, maxBytes)
  }

  totalSizeFrom(response: Response, received: number): number {
    return totalSizeFrom(response, received)
  }

  cookiePairsFromResponse(response: Response): string[] {
    return cookiePairsFromResponse(response)
  }

  async requestWithToken(url: string, token: string, timeoutMs: number): Promise<Response> {
    const headers = this.authHeaders(url, 'token', {}, { token })
    const response = await this.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    })
    await this.ensureOk(response, 'GET', url)
    return response
  }

  async requestWithCookie(url: string, cookie: string, timeoutMs: number): Promise<Response> {
    const headers: Record<string, string> = { 'User-Agent': this.userAgent }
    if (this.policy.allowsAuth(url)) headers.Cookie = formatSessionCookie(cookie)
    const response = await this.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    })
    await this.ensureOk(response, 'GET', url)
    return response
  }

  private async fetchWithPolicy(
    url: string,
    init: RequestInit,
    retryStatuses: readonly number[]
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.scheduler.run(() => this.fetchImpl(url, init))
      if (this.retry.shouldRetry(res.status, attempt, retryStatuses)) {
        void res.body?.cancel().catch(() => undefined)
        await this.retry.wait(res.headers.get('Retry-After'), attempt)
        continue
      }
      return res
    }
  }

  private authHeaders(
    url: string,
    auth: AuthMode,
    options: AuthHeaderOptions,
    explicit: { readonly token?: string; readonly cookie?: string } = {}
  ): Record<string, string> {
    const headers: Record<string, string> = { 'User-Agent': this.userAgent }
    if (auth === 'cookie') {
      const cookie = explicit.cookie ?? this.getSessionCookie()
      if (!cookie || !this.policy.allowsAuth(url)) throw new CookieRequiredError(url)
      headers.Cookie = formatSessionCookie(
        cookie,
        options.extraCookies ? [...options.extraCookies] : []
      )
      headers.Origin = this.endpoint
      headers.Referer = options.referer ?? `${this.endpoint}/`
      return headers
    }
    const token = explicit.token ?? this.getAccessToken()
    if (token && this.policy.allowsAuth(url)) headers.Authorization = `Bearer ${token}`
    return headers
  }

  private additionalHeaders(headers: RequestInit['headers']): Record<string, string> {
    if (!headers) return {}
    if (headers instanceof Headers) return Object.fromEntries(headers.entries())
    if (Array.isArray(headers)) return Object.fromEntries(headers)
    const entries: Array<[string, string]> = []
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === 'string') entries.push([name, value])
    }
    return Object.fromEntries(entries)
  }

  private parseLinkNext(header: string | null): string | undefined {
    if (!header) return undefined
    for (const part of header.split(',')) {
      const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
      if (match) return match[1]
    }
    return undefined
  }
}
