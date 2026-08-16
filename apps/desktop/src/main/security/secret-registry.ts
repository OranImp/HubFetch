/**
 * Bounded process-local secret registry (plan Todo 22).
 *
 * Ports the archived Python `SecretRegistry` semantics and adds the bounded
 * lifecycle the plan requires: opaque handles, reference counting, TTL expiry,
 * a minimum useful length, capacity/length caps, and zeroization — every
 * internal reference is dropped on unregister/purge (JS strings are immutable,
 * so "zeroization" means the registry retains no copy of a value once its last
 * registration ends). The registry is the ONLY place main-process secrets are
 * held in memory, and its contents are never serializable or printable.
 *
 * The shared `secretRegistry` singleton feeds the process-wide `redactor`
 * (see ./log.ts) so a registered token redacts at every log/error boundary
 * until its owning registration is released.
 */
import { REDACTED, RedactionError } from './redaction'

/** Below this length a value is too common to redact safely by exact value. */
export const DEFAULT_MIN_SECRET_LENGTH = 8
/** Hard cap on concurrent registered values (bounds the redaction scan). */
export const DEFAULT_MAX_SECRETS = 64
/** Hard cap on one registered value (bounds a single scan pass). */
export const DEFAULT_MAX_SECRET_LENGTH = 4096

export interface SecretRegistryOptions {
  minLength?: number
  maxSecrets?: number
  maxSecretLength?: number
}

export interface RegisterOptions {
  /** The registration self-expires after this many milliseconds. */
  ttlMs?: number
  /** Per-call override of the registry minimum length. */
  minLength?: number
}

/**
 * Opaque registration handle. The handle intentionally carries no secret
 * material — only the caller that registered it can use it to unregister.
 */
export interface SecretHandle {
  readonly kind: 'secret-handle'
  readonly id: number
}

interface Entry {
  readonly value: string
  refCount: number
  readonly expiresAt: number | null
}

export class SecretRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly handles = new Map<number, string>()
  private nextHandleId = 1

  readonly minLength: number
  readonly maxSecrets: number
  readonly maxSecretLength: number

  constructor(options: SecretRegistryOptions = {}) {
    this.minLength = options.minLength ?? DEFAULT_MIN_SECRET_LENGTH
    this.maxSecrets = options.maxSecrets ?? DEFAULT_MAX_SECRETS
    this.maxSecretLength = options.maxSecretLength ?? DEFAULT_MAX_SECRET_LENGTH
  }

  /** Register a secret for value redaction; returns an opaque handle. */
  register(secret: string, options: RegisterOptions = {}): SecretHandle {
    this.purgeExpired()
    const min = options.minLength ?? this.minLength
    if (!secret) {
      throw new RedactionError('a registered secret must be non-empty')
    }
    if (secret === REDACTED) {
      throw new RedactionError('the redaction token itself cannot be a secret')
    }
    if (secret.length < min) {
      throw new RedactionError(
        `a registered secret must be at least ${min} characters (got ${secret.length})`
      )
    }
    if (secret.length > this.maxSecretLength) {
      throw new RedactionError(
        `a registered secret exceeds the ${this.maxSecretLength}-character cap`
      )
    }
    const existing = this.entries.get(secret)
    if (!existing && this.entries.size >= this.maxSecrets) {
      throw new RedactionError(`registry capacity reached (${this.maxSecrets} live secrets)`)
    }
    if (existing) {
      existing.refCount += 1
    } else {
      this.entries.set(secret, {
        value: secret,
        refCount: 1,
        expiresAt: options.ttlMs !== undefined ? Date.now() + options.ttlMs : null
      })
    }
    const handle: SecretHandle = { kind: 'secret-handle', id: this.nextHandleId++ }
    this.handles.set(handle.id, secret)
    return handle
  }

  /**
   * Release one registration by opaque handle or by exact value. Returns
   * whether a registration was actually released.
   */
  unregister(ref: SecretHandle | string): boolean {
    this.purgeExpired()
    const value = typeof ref === 'string' ? ref : this.handles.get(ref.id)
    if (value === undefined) return false
    const entry = this.entries.get(value)
    if (!entry) return false
    entry.refCount -= 1
    if (typeof ref === 'object') this.handles.delete(ref.id)
    if (entry.refCount <= 0) this.forget(value)
    return true
  }

  /**
   * Register several secrets and return a release function that unregisters
   * exactly these registrations (the bounded equivalent of a context manager).
   */
  bound(...secrets: string[]): () => void {
    const handles = secrets.map((secret) => this.register(secret))
    return () => {
      for (const handle of handles) this.unregister(handle)
    }
  }

  isRegistered(secret: string): boolean {
    this.purgeExpired()
    return this.entries.has(secret)
  }

  /** Current number of distinct live secret values. */
  get size(): number {
    this.purgeExpired()
    return this.entries.size
  }

  /**
   * Internal redactor seam: live values sorted longest-first for deterministic
   * replacement. NEVER for serialization — this is the only window into the
   * contents and it exists solely so the redactor can substitute by value.
   * Returns a defensive copy.
   */
  liveSecrets(): string[] {
    this.purgeExpired()
    return [...this.entries.keys()].sort((a, b) => b.length - a.length)
  }

  /** Drop every registration that has passed its TTL. */
  expireNow(): void {
    this.purgeExpired()
  }

  /**
   * Zeroize the registry: drop every internal reference. Call on app shutdown
   * and wherever a session boundary (auth change, task completion) must not
   * carry secrets forward. Stale handles subsequently unregister as false.
   */
  purge(): void {
    this.entries.clear()
    this.handles.clear()
  }

  /** Serialization is never allowed — the registry is not an artifact. */
  toJSON(): never {
    throw new TypeError('SecretRegistry must never be serialized')
  }

  toString(): string {
    return `SecretRegistry(registered=${this.size})`
  }

  private purgeExpired(): void {
    const now = Date.now()
    for (const [value, entry] of this.entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) this.forget(value)
    }
  }

  private forget(value: string): void {
    this.entries.delete(value)
    for (const [id, candidate] of this.handles) {
      if (candidate === value) this.handles.delete(id)
    }
  }
}

/** Process-wide registry shared by the log/error redactor. */
export const secretRegistry = new SecretRegistry()
