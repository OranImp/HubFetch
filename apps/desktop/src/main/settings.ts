import type { AppSettings, LlmProvider, LlmProviderConfig, LlmSettings } from '@hubfetch/shared'
import {
  DEFAULT_LLM_SETTINGS,
  DEFAULT_PROXY_CONFIG,
  DEFAULT_SETTINGS,
  LLM_PROVIDERS
} from '@hubfetch/shared'
import type { AppDatabase } from './db'

type Listener = (settings: AppSettings) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === 'string' && LLM_PROVIDERS.some((provider) => provider === value)
}

function normalizeProvider(raw: unknown): LlmProviderConfig {
  if (!isRecord(raw)) return { modelId: '', baseUrl: null }
  return {
    modelId: typeof raw.modelId === 'string' ? raw.modelId : '',
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : null
  }
}

function normalizeLlmSettings(raw: unknown): LlmSettings {
  if (!isRecord(raw)) return DEFAULT_LLM_SETTINGS
  const providersRaw = isRecord(raw.providers) ? raw.providers : {}
  return {
    activeProvider: isLlmProvider(raw.activeProvider)
      ? raw.activeProvider
      : DEFAULT_LLM_SETTINGS.activeProvider,
    providers: {
      openai: normalizeProvider(providersRaw.openai),
      anthropic: normalizeProvider(providersRaw.anthropic),
      gemini: normalizeProvider(providersRaw.gemini)
    }
  }
}

export class SettingsStore {
  private cached: AppSettings
  private listeners = new Set<Listener>()

  constructor(private readonly db: AppDatabase) {
    this.cached = this.load()
  }

  private load(): AppSettings {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get('settings') as
      | { value: string }
      | undefined
    if (!row) return { ...DEFAULT_SETTINGS }
    try {
      const stored = JSON.parse(row.value) as Partial<AppSettings> & { proxyUrl?: unknown }
      // Belt-and-suspenders beside the DB migration: never carry a legacy
      // nullable proxyUrl into memory, and always have a closed proxy config.
      delete stored.proxyUrl
      if (!stored.proxy) stored.proxy = { ...DEFAULT_PROXY_CONFIG }
      return { ...DEFAULT_SETTINGS, ...stored, llm: normalizeLlmSettings(stored.llm) }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  get(): AppSettings {
    return this.cached
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const merged = { ...this.cached, ...patch }
    this.cached = { ...merged, llm: normalizeLlmSettings(merged.llm) }
    this.db
      .prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run('settings', JSON.stringify(this.cached))
    for (const listener of this.listeners) listener(this.cached)
    return this.cached
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
