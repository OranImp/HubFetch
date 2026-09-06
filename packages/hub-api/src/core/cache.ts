export interface CacheEntry {
  readonly at: number
  readonly status: number
  readonly body: unknown
  readonly nextUrl?: string
}

export interface CachedJson<T> {
  readonly body: T
  readonly nextUrl?: string
}

/** Auth-partitioned GET cache plus JSON/text in-flight coalescing. */
export class GetCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<unknown>>()

  constructor(private readonly getAccessToken: () => string | undefined) {}

  key(url: string): string {
    return `${this.getAccessToken() ? 'auth' : 'anon'}:${url}`
  }

  fresh<T>(key: string, ttl: number): CachedJson<T> | undefined {
    const entry = this.entries.get(key)
    if (!entry || Date.now() - entry.at >= ttl) return undefined
    return { body: entry.body as T, nextUrl: entry.nextUrl }
  }

  stale(key: string): CacheEntry | undefined {
    return this.entries.get(key)
  }

  set(key: string, entry: CacheEntry): void {
    this.entries.set(key, entry)
  }

  async coalesce<T>(key: string, request: () => Promise<T>): Promise<T> {
    const pending = this.inflight.get(key)
    if (pending) return pending as Promise<T>
    const current = request().finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, current)
    return current
  }

  clear(): void {
    this.entries.clear()
  }
}
