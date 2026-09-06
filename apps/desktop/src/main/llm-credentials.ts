import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import type { LlmConfiguredStatus, LlmProvider } from '@hubfetch/shared'
import { writeCredentialsFileAtomic } from './credential-file'
import { llmCredentialsFile } from './runtime-paths'
import { logger } from './security/log'
import { secretRegistry, type SecretHandle } from './security/secret-registry'

const SUPPORTED_VERSION = 1
const LLM_PROVIDERS: readonly LlmProvider[] = ['openai', 'anthropic', 'gemini'] as const

type LlmPayload = {
  version: number
  keys: Partial<Record<LlmProvider, string>>
}

function isLlmProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(value)
}

export class LlmCredentialStore {
  private keys: Partial<Record<LlmProvider, string>> = {}
  private handles = new Map<LlmProvider, SecretHandle>()
  private transientHandles = new Set<SecretHandle>()

  async load(): Promise<void> {
    this.clearRegistrations()
    this.keys = {}
    if (!safeStorage.isEncryptionAvailable()) return
    const file = llmCredentialsFile()
    if (!existsSync(file)) return
    try {
      const raw = readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw) as { version?: unknown; cipher?: unknown }
      if (parsed.version !== SUPPORTED_VERSION) {
        logger.warn('llm-credentials', 'unsupported llm credentials version, failing closed')
        return
      }
      if (typeof parsed.cipher !== 'string' || parsed.cipher.length === 0) {
        logger.warn('llm-credentials', 'missing cipher in llm credentials, failing closed')
        return
      }
      const decrypted = safeStorage.decryptString(Buffer.from(parsed.cipher, 'base64'))
      const payload = JSON.parse(decrypted) as LlmPayload
      if (payload.version !== SUPPORTED_VERSION || typeof payload.keys !== 'object' || payload.keys === null) {
        logger.warn('llm-credentials', 'invalid llm credentials payload, failing closed')
        return
      }
      const next: Partial<Record<LlmProvider, string>> = {}
      for (const [k, v] of Object.entries(payload.keys)) {
        if (!isLlmProvider(k)) continue
        if (typeof v !== 'string' || v.length === 0) continue
        next[k] = v
      }
      this.keys = next
      this.registerAll()
    } catch (err) {
      logger.warn('llm-credentials', 'failed to load llm credentials, failing closed', err)
      this.clearRegistrations()
      this.keys = {}
    }
  }

  getStatus(): LlmConfiguredStatus {
    return {
      openai: Boolean(this.keys.openai),
      anthropic: Boolean(this.keys.anthropic),
      gemini: Boolean(this.keys.gemini),
    }
  }

  getKey(provider: LlmProvider): string | undefined {
    return this.keys[provider]
  }

  setKey(provider: LlmProvider, key: string): void {
    const trimmed = key.trim()
    if (trimmed.length === 0) {
      this.deleteKey(provider)
      return
    }
    const previous = this.keys[provider]
    if (previous !== undefined) {
      const handle = this.handles.get(provider)
      if (handle) {
        secretRegistry.unregister(handle)
        this.handles.delete(provider)
      } else {
        secretRegistry.unregister(previous)
      }
    }
    this.keys[provider] = trimmed
    try {
      const handle = secretRegistry.register(trimmed)
      this.handles.set(provider, handle)
    } catch {
      // Too short or invalid still persists encrypted; redaction is best-effort.
    }
    this.persist()
  }

  deleteKey(provider: LlmProvider): void {
    const existing = this.keys[provider]
    if (existing === undefined) return
    const handle = this.handles.get(provider)
    if (handle) {
      secretRegistry.unregister(handle)
      this.handles.delete(provider)
    } else {
      secretRegistry.unregister(existing)
    }
    delete this.keys[provider]
    this.persist()
  }

  registerTransient(secret: string): SecretHandle {
    const handle = secretRegistry.register(secret)
    this.transientHandles.add(handle)
    return handle
  }

  unregisterTransient(handle: SecretHandle): void {
    if (this.transientHandles.has(handle)) {
      secretRegistry.unregister(handle)
      this.transientHandles.delete(handle)
    }
  }

  dispose(): void {
    for (const handle of this.handles.values()) {
      secretRegistry.unregister(handle)
    }
    this.handles.clear()
    for (const handle of this.transientHandles) {
      secretRegistry.unregister(handle)
    }
    this.transientHandles.clear()
    this.keys = {}
  }

  private registerAll(): void {
    for (const provider of LLM_PROVIDERS) {
      const value = this.keys[provider]
      if (value === undefined) continue
      try {
        const handle = secretRegistry.register(value)
        this.handles.set(provider, handle)
      } catch {
        // Best-effort registration for redaction.
      }
    }
  }

  private clearRegistrations(): void {
    for (const handle of this.handles.values()) {
      secretRegistry.unregister(handle)
    }
    this.handles.clear()
  }

  private persist(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      logger.warn('llm-credentials', 'OS encryption unavailable; llm key will not be persisted')
      return
    }
    try {
      const file = llmCredentialsFile()
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const payload: LlmPayload = { version: SUPPORTED_VERSION, keys: { ...this.keys } }
      const cipher = safeStorage.encryptString(JSON.stringify(payload))
      writeCredentialsFileAtomic(file, JSON.stringify({ version: SUPPORTED_VERSION, cipher: cipher.toString('base64') }))
    } catch (err) {
      logger.warn('llm-credentials', 'failed to persist llm credentials', err)
    }
  }
}
