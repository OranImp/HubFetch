import { describe, expect, it } from 'vitest'
import { DEFAULT_PROXY_CONFIG, DEFAULT_SETTINGS } from '@hubfetch/shared'
import type { AppDatabase } from './db'
import { SettingsStore } from './settings'

function createKvDb(initial?: string): {
  db: AppDatabase
  readSettingsJson: () => string | undefined
} {
  let value = initial
  const db = {
    prepare(sql: string) {
      return {
        get: () => (value === undefined ? undefined : { value }),
        run: (...params: unknown[]) => {
          if (sql.includes('INSERT INTO kv')) {
            value = params[1] as string
          }
        }
      }
    }
  } as unknown as AppDatabase
  return { db, readSettingsJson: () => value }
}

const COMPLETE_DEFAULT_LLM = {
  activeProvider: 'openai',
  providers: {
    openai: { modelId: '', baseUrl: null },
    anthropic: { modelId: '', baseUrl: null },
    gemini: { modelId: '', baseUrl: null }
  }
} as const

describe('SettingsStore LLM nested defaults', () => {
  it('loads a legacy settings row with no llm field as the complete three-provider default', () => {
    const { db } = createKvDb(JSON.stringify({ theme: 'dark', locale: 'zh-CN' }))
    const store = new SettingsStore(db)
    const settings = store.get()

    expect(settings.theme).toBe('dark')
    expect(settings.locale).toBe('zh-CN')
    expect(settings.llm).toEqual(COMPLETE_DEFAULT_LLM)
    expect(settings.llm.activeProvider).toBe('openai')
    expect(settings.llm.providers.openai.modelId).toBe('')
    expect(settings.llm.providers.anthropic.baseUrl).toBeNull()
    expect(settings.llm.providers.gemini.baseUrl).toBeNull()
  })

  it('returns complete LLM defaults when the kv row is missing', () => {
    const { db } = createKvDb()
    const store = new SettingsStore(db)
    expect(store.get().llm).toEqual(COMPLETE_DEFAULT_LLM)
    expect(DEFAULT_SETTINGS.llm).toEqual(COMPLETE_DEFAULT_LLM)
  })

  it('fills missing providers and provider fields on a partial nested llm object', () => {
    const { db } = createKvDb(
      JSON.stringify({
        llm: {
          activeProvider: 'gemini',
          providers: {
            openai: { modelId: 'gpt-4o-mini' }
          }
        }
      })
    )
    const store = new SettingsStore(db)
    expect(store.get().llm).toEqual({
      activeProvider: 'gemini',
      providers: {
        openai: { modelId: 'gpt-4o-mini', baseUrl: null },
        anthropic: { modelId: '', baseUrl: null },
        gemini: { modelId: '', baseUrl: null }
      }
    })
  })

  it('strips API key fields so they never become part of AppSettings', () => {
    const { db, readSettingsJson } = createKvDb(
      JSON.stringify({
        llm: {
          activeProvider: 'openai',
          providers: {
            openai: {
              modelId: 'gpt-4o',
              baseUrl: 'https://api.openai.com/v1',
              apiKey: 'sk-secret-must-not-leak'
            },
            anthropic: { modelId: '', baseUrl: null, key: 'sk-ant-secret' },
            gemini: { modelId: '', baseUrl: null, api_key: 'gemini-secret' }
          }
        }
      })
    )
    const store = new SettingsStore(db)
    const llm = store.get().llm
    expect(llm.providers.openai).toEqual({
      modelId: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1'
    })
    expect(llm.providers.openai).not.toHaveProperty('apiKey')
    expect(llm.providers.anthropic).not.toHaveProperty('key')
    expect(llm.providers.gemini).not.toHaveProperty('api_key')
    expect(JSON.stringify(store.get())).not.toContain('sk-secret-must-not-leak')
    expect(JSON.stringify(store.get())).not.toContain('sk-ant-secret')
    expect(JSON.stringify(store.get())).not.toContain('gemini-secret')

    store.set({ theme: 'dark' })
    const persisted = readSettingsJson()
    expect(persisted).toBeDefined()
    expect(persisted).not.toContain('apiKey')
    expect(persisted).not.toContain('sk-secret-must-not-leak')
    expect(persisted).toContain('"modelId":"gpt-4o"')
    expect(persisted).toContain('https://api.openai.com/v1')
  })

  it('merges a complete llm patch on set without dropping other providers', () => {
    const { db } = createKvDb(
      JSON.stringify({
        llm: {
          activeProvider: 'openai',
          providers: {
            openai: { modelId: 'gpt-4o-mini', baseUrl: null },
            anthropic: { modelId: '', baseUrl: null },
            gemini: { modelId: 'gemini-2.5-flash', baseUrl: null }
          }
        }
      })
    )
    const store = new SettingsStore(db)
    store.set({
      llm: {
        activeProvider: 'anthropic',
        providers: {
          openai: { modelId: 'gpt-4o-mini', baseUrl: null },
          anthropic: { modelId: 'claude-sonnet-4-0', baseUrl: null },
          gemini: { modelId: 'gemini-2.5-flash', baseUrl: null }
        }
      }
    })
    expect(store.get().llm).toEqual({
      activeProvider: 'anthropic',
      providers: {
        openai: { modelId: 'gpt-4o-mini', baseUrl: null },
        anthropic: { modelId: 'claude-sonnet-4-0', baseUrl: null },
        gemini: { modelId: 'gemini-2.5-flash', baseUrl: null }
      }
    })
  })

  it('keeps existing shallow settings behavior for proxy and top-level fields', () => {
    const { db } = createKvDb(
      JSON.stringify({
        theme: 'light',
        proxyUrl: 'http://127.0.0.1:7890',
        proxy: { mode: 'direct' }
      })
    )
    const store = new SettingsStore(db)
    const settings = store.get()
    expect(settings.theme).toBe('light')
    expect(settings).not.toHaveProperty('proxyUrl')
    expect(settings.proxy).toEqual({ mode: 'direct' })
    expect(settings.proxy).not.toEqual(DEFAULT_PROXY_CONFIG)
    expect(settings.downloadConcurrency).toBe(DEFAULT_SETTINGS.downloadConcurrency)
    expect(settings.llm).toEqual(COMPLETE_DEFAULT_LLM)
  })

  it('fills missing proxy from defaults without rewriting a present proxy object', () => {
    const missingProxy = createKvDb(JSON.stringify({ locale: 'ja' }))
    const filled = new SettingsStore(missingProxy.db)
    expect(filled.get().proxy).toEqual(DEFAULT_PROXY_CONFIG)
    expect(filled.get().locale).toBe('ja')

    const { db } = createKvDb(JSON.stringify({ proxy: { mode: 'manual', extra: true } }))
    const shallow = new SettingsStore(db)
    expect(shallow.get().proxy).toEqual({ mode: 'manual', extra: true })
  })

  it('serializes an export-shaped snapshot with provider/model/base URL and no key fields', () => {
    const { db } = createKvDb(
      JSON.stringify({
        llm: {
          activeProvider: 'openai',
          providers: {
            openai: { modelId: 'gpt-4o-mini', baseUrl: 'https://example.invalid/v1' },
            anthropic: { modelId: '', baseUrl: null },
            gemini: { modelId: 'gemini-2.5-flash', baseUrl: null }
          }
        }
      })
    )
    const store = new SettingsStore(db)
    const { hfCacheDir: _cache, ...portable } = store.get()
    expect(portable.llm.activeProvider).toBe('openai')
    expect(portable.llm.providers.openai.modelId).toBe('gpt-4o-mini')
    expect(portable.llm.providers.openai.baseUrl).toBe('https://example.invalid/v1')
    expect(portable.llm.providers.gemini.modelId).toBe('gemini-2.5-flash')
    const serialized = JSON.stringify({ version: 1, exportedAt: '2026-08-20T00:00:00.000Z', settings: portable })
    expect(serialized).toContain('gpt-4o-mini')
    expect(serialized).toContain('https://example.invalid/v1')
    expect(serialized).not.toMatch(/apiKey|api_key|"key"/)
  })
})
