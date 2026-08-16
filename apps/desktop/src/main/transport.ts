/**
 * Per-task transport policy for Hub API fetches, download workers, and
 * Chromium traffic.
 *
 * Each download task owns a dedicated Chromium session partition
 * ('persist:hubfetch-task-<id>') so concurrent tasks carrying different proxy
 * snapshots never share one session:
 *   System  -> session proxy mode 'system'; the OS route is resolved per
 *              request at execution time via session.resolveProxy(targetUrl)
 *              and translated from the ordered PROXY/HTTPS/SOCKS/DIRECT
 *              result WITHOUT mutating any settings.
 *   Manual  -> an Undici ProxyAgent pinned to the frozen URL.
 *   Direct  -> an explicit Undici Agent (never WinINET/PAC) and Chromium
 *              mode 'direct'.
 *
 * Dispatchers are injected per task (never setGlobalDispatcher) and cached in
 * a reference-counted pool so they can be closed when the task settles or the
 * app shuts down. The parent environment is never mutated.
 */
import { session, type Session } from 'electron'
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import type { ProxySnapshot } from '@hubfetch/shared'

export const TASK_PARTITION_PREFIX = 'persist:hubfetch-task-'

/** Raw PAC-style resolver: returns the OS proxy resolution string for a URL. */
export type ProxyResolver = (url: string) => Promise<string>

/**
 * Chromium proxy resolutions use a semicolon-delimited PAC format such as
 * "PROXY 127.0.0.1:7890; DIRECT". Undici needs an absolute proxy URL.
 * SOCKS/QUIC routes are recognized but skipped because undici's ProxyAgent
 * only speaks HTTP(S); the next usable fallback wins, DIRECT yields null.
 */
export function proxyUrlFromResolution(resolution: string): string | null {
  for (const directive of resolution.split(';')) {
    const [kind = '', address = ''] = directive.trim().split(/\s+/, 2)
    const normalizedKind = kind.toUpperCase()
    if (normalizedKind === 'DIRECT') return null
    if (!address) continue
    const protocol =
      normalizedKind === 'PROXY' || normalizedKind === 'HTTP'
        ? 'http'
        : normalizedKind === 'HTTPS'
          ? 'https'
          : null
    if (!protocol) continue
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `${protocol}://${address}`
    try {
      const parsed = new URL(candidate)
      if (parsed.hostname) return parsed.toString().replace(/\/$/, '')
    } catch {
      // Ignore malformed PAC entries and continue to the next fallback.
    }
  }
  return null
}

type FetchInput = Parameters<typeof fetch>[0]

function fetchInputUrl(input: FetchInput): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function undiciFetchWith(
  input: FetchInput,
  init: RequestInit | undefined,
  dispatcher: Dispatcher
): Promise<Response> {
  return undiciFetch(
    input as never,
    {
      ...(init as object),
      dispatcher
    } as never
  ) as unknown as Promise<Response>
}

/**
 * Reference-counted undici dispatcher cache. Agents are shared per policy key
 * across tasks and only closed when the last reference is released or the
 * pool is closed wholesale.
 */
export class DispatcherPool {
  private readonly agents = new Map<string, { dispatcher: Dispatcher; refs: number }>()

  acquire(key: string, factory: () => Dispatcher): Dispatcher {
    let entry = this.agents.get(key)
    if (!entry) {
      entry = { dispatcher: factory(), refs: 0 }
      this.agents.set(key, entry)
    }
    entry.refs += 1
    return entry.dispatcher
  }

  release(key: string): void {
    const entry = this.agents.get(key)
    if (!entry) return
    entry.refs -= 1
    if (entry.refs > 0) return
    this.agents.delete(key)
    void entry.dispatcher.close?.()
  }

  keys(): string[] {
    return [...this.agents.keys()]
  }

  async closeAll(): Promise<void> {
    for (const [, entry] of this.agents) {
      await entry.dispatcher.close?.()
    }
    this.agents.clear()
  }
}

const defaultPool = new DispatcherPool()

/** Close the app-level dispatcher pool (used by createProxiedFetch). */
export function closeDefaultTransportPool(): Promise<void> {
  return defaultPool.closeAll()
}

export interface TaskFetchOptions {
  pool?: DispatcherPool
  /** System-mode resolver: concrete HTTP(S) proxy URL for a target, or null for direct. */
  resolver?: (url: string) => Promise<string | null>
  /** Called on every dispatcher acquisition so a task can track/refcount its keys. */
  onAcquire?: (key: string) => void
}

export interface TaskFetch {
  fetchImpl: typeof fetch
  /** Concrete proxy URL for a target (system resolves; manual pins; direct returns null). */
  resolveProxyFor: (url: string) => Promise<string | null>
}

/**
 * Build a snapshot-aware fetch. System mode resolves the OS route at request
 * execution; Manual pins an Undici ProxyAgent; Direct uses an explicit direct
 * Agent (never WinINET/PAC). No dispatcher is ever installed globally.
 */
export function createTaskFetch(snapshot: ProxySnapshot, opts: TaskFetchOptions = {}): TaskFetch {
  const pool = opts.pool ?? defaultPool
  const acquire = (key: string, factory: () => Dispatcher): Dispatcher => {
    opts.onAcquire?.(key)
    return pool.acquire(key, factory)
  }

  switch (snapshot.mode) {
    case 'manual': {
      const agent = acquire(`manual:${snapshot.url}`, () => new ProxyAgent(snapshot.url))
      return {
        fetchImpl: (input, init) => undiciFetchWith(input, init, agent),
        resolveProxyFor: async () => snapshot.url
      }
    }
    case 'direct': {
      const agent = acquire('direct', () => new Agent())
      return {
        fetchImpl: (input, init) => undiciFetchWith(input, init, agent),
        resolveProxyFor: async () => null
      }
    }
    case 'system': {
      const resolveProxyFor = async (url: string): Promise<string | null> => {
        try {
          const resolved = (await opts.resolver?.(url)) ?? null
          if (!resolved) return null
          // A resolver that echoes the raw PAC string (e.g. 'DIRECT') still
          // means direct — never feed it to a ProxyAgent.
          if (/^DIRECT$/i.test(resolved.trim())) return null
          return resolved
        } catch {
          // Preserve direct networking if the proxy service cannot initialize.
          return null
        }
      }
      const fetchImpl = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
        const proxyUrl = await resolveProxyFor(fetchInputUrl(input))
        if (proxyUrl) {
          return undiciFetchWith(
            input,
            init,
            acquire(`system:${proxyUrl}`, () => new ProxyAgent(proxyUrl))
          )
        }
        return undiciFetchWith(
          input,
          init,
          acquire('direct', () => new Agent())
        )
      }
      return { fetchImpl, resolveProxyFor }
    }
  }
}

export interface TaskTransport {
  readonly taskId: string
  readonly snapshot: ProxySnapshot
  readonly partition: string
  /** Chromium session configured for this task's snapshot. */
  readonly ses: Session
  /** Node-side fetch bound to this task's transport policy. */
  readonly fetchImpl: typeof fetch
  /** Concrete HTTP(S) proxy URL for a target; null = direct/unsupported. */
  resolveProxyFor(url: string): Promise<string | null>
  /** Release this task's dispatchers and connections. Idempotent. */
  close(): Promise<void>
}

export interface ProxyTransportManagerOptions {
  sessionFactory?: (partition: string) => Session
}

class TaskTransportImpl implements TaskTransport {
  readonly taskId: string
  readonly snapshot: ProxySnapshot
  readonly partition: string
  readonly ses: Session
  private readonly ready: Promise<void>
  private readonly keyRefs = new Map<string, number>()
  private readonly pool: DispatcherPool
  private readonly fetch: TaskFetch

  constructor(
    taskId: string,
    snapshot: ProxySnapshot,
    pool: DispatcherPool,
    sessionFactory: (partition: string) => Session
  ) {
    this.taskId = taskId
    this.snapshot = snapshot
    this.partition = `${TASK_PARTITION_PREFIX}${taskId}`
    this.ses = sessionFactory(this.partition)
    this.pool = pool
    this.ready = configureSession(this.ses, snapshot).catch(() => undefined)
    this.fetch = createTaskFetch(snapshot, {
      pool,
      // System mode: ask THIS task's Chromium session, translate the ordered
      // PROXY/HTTPS/SOCKS/DIRECT result; settings are never touched.
      resolver: async (url: string): Promise<string | null> => {
        await this.ready
        try {
          return proxyUrlFromResolution(await this.ses.resolveProxy(url))
        } catch {
          return null
        }
      },
      onAcquire: (key: string) => {
        this.keyRefs.set(key, (this.keyRefs.get(key) ?? 0) + 1)
      }
    })
  }

  get fetchImpl(): typeof fetch {
    return this.fetch.fetchImpl
  }

  async resolveProxyFor(url: string): Promise<string | null> {
    await this.ready
    return this.fetch.resolveProxyFor(url)
  }

  async close(): Promise<void> {
    for (const [key, count] of this.keyRefs) {
      for (let i = 0; i < count; i++) this.pool.release(key)
    }
    this.keyRefs.clear()
    try {
      this.ses.closeAllConnections?.()
    } catch {
      // Best effort; the session itself is freed when its partition is dropped.
    }
  }
}

/**
 * Per-app transport factory. Creates one Chromium session partition per task
 * so concurrent tasks with different snapshots never share a session, and
 * caches/refcounts the underlying undici dispatchers for release on task/app
 * shutdown.
 */
export class ProxyTransportManager {
  private readonly pool = new DispatcherPool()
  private readonly transports = new Map<string, TaskTransport>()
  private readonly sessionFactory: (partition: string) => Session

  constructor(opts: ProxyTransportManagerOptions = {}) {
    this.sessionFactory = opts.sessionFactory ?? ((partition) => session.fromPartition(partition))
  }

  transportFor(taskId: string, snapshot: ProxySnapshot): TaskTransport {
    const existing = this.transports.get(taskId)
    if (existing) return existing
    const transport = new TaskTransportImpl(taskId, snapshot, this.pool, this.sessionFactory)
    this.transports.set(taskId, transport)
    return transport
  }

  async closeTask(taskId: string): Promise<void> {
    const transport = this.transports.get(taskId)
    if (!transport) return
    this.transports.delete(taskId)
    await transport.close()
  }

  async closeAll(): Promise<void> {
    for (const transport of this.transports.values()) {
      await transport.close().catch(() => undefined)
    }
    this.transports.clear()
    await this.pool.closeAll()
  }
}

function configureSession(ses: Session, snapshot: ProxySnapshot): Promise<void> {
  switch (snapshot.mode) {
    case 'manual':
      return ses.setProxy({ proxyRules: snapshot.url })
    case 'direct':
      return ses.setProxy({ mode: 'direct' })
    case 'system':
      return ses.setProxy({ mode: 'system' })
  }
}
