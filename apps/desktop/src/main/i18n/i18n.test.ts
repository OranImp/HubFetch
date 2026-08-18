import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MainI18n, matchLocale } from './index'

const localesDir = join(__dirname, 'locales')

function flatEntries(obj: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  return Object.entries(obj).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null
      ? flatEntries(value as Record<string, unknown>, `${prefix}${key}.`)
      : [[`${prefix}${key}`, value] as [string, unknown]]
  )
}

function placeholders(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort()
}

function baseKeys(obj: Record<string, unknown>): string[] {
  return [
    ...new Set(flatEntries(obj).map(([key]) => key.replace(/_(zero|one|two|few|many|other)$/, '')))
  ].sort()
}

describe('matchLocale', () => {
  it('maps system locales to supported app locales', () => {
    expect(matchLocale('en-US')).toBe('en')
    expect(matchLocale('zh-CN')).toBe('zh-CN')
    expect(matchLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(matchLocale('zh-TW')).toBe('zh-TW')
    expect(matchLocale('zh-Hant-TW')).toBe('zh-TW')
    expect(matchLocale('zh-HK')).toBe('zh-TW')
    expect(matchLocale('fr-FR')).toBe('fr')
    expect(matchLocale('ja-JP')).toBe('ja')
    expect(matchLocale('ko-KR')).toBe('ko')
    expect(matchLocale('de-DE')).toBe('de')
    expect(matchLocale('es-ES')).toBe('es')
    expect(matchLocale('pt-BR')).toBe('pt-BR')
    expect(matchLocale('pt-PT')).toBe('pt-BR')
    expect(matchLocale('it-IT')).toBe('en')
  })
})

describe('MainI18n', () => {
  it('translates with interpolation', () => {
    const i18n = new MainI18n()
    i18n.setLocale('en')
    expect(i18n.t('menu.models')).toBe('Models')
    expect(i18n.t('menu.history')).toBe('Browse History')
    expect(i18n.t('notifications.downloadCompleteBody', { repo: 'a/b' })).toBe(
      'a/b finished downloading.'
    )
  })

  it('switches locales and falls back to English for unknown keys', () => {
    const i18n = new MainI18n()
    i18n.setLocale('zh-CN')
    expect(i18n.t('menu.models')).toBe('模型')
    expect(i18n.t('menu.history')).toBe('浏览历史')
    expect(i18n.t('does.not.exist')).toBe('does.not.exist')
  })

  it('translates in a newly added locale', () => {
    const i18n = new MainI18n()
    i18n.setLocale('de')
    expect(i18n.t('menu.models')).toBe('Modelle')
    expect(i18n.t('menu.history')).toBe('Browserverlauf')
  })
})

describe('main locale catalog contract', () => {
  const files = readdirSync(localesDir).filter((name) => name.endsWith('.json'))
  const en = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8')) as Record<
    string,
    unknown
  >
  const enFlat = new Map(flatEntries(en))

  it('ships exactly the nine supported main catalogs', () => {
    expect(files.map((f) => f.replace(/\.json$/, '')).sort()).toEqual(
      ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-CN', 'zh-TW'].sort()
    )
  })

  for (const file of files.filter((f) => f !== 'en.json')) {
    const locale = file.replace(/\.json$/, '')
    it(`${locale} mirrors the English key set and placeholder set`, () => {
      const other = JSON.parse(readFileSync(join(localesDir, file), 'utf8')) as Record<
        string,
        unknown
      >
      const otherFlat = new Map(flatEntries(other))
      // Exact key-set parity (missing AND extra both fail).
      expect([...otherFlat.keys()].sort()).toEqual([...enFlat.keys()].sort())
      // No empty strings.
      for (const [key, value] of otherFlat) {
        expect(typeof value, key).toBe('string')
        expect(value, key).not.toBe('')
      }
      // Placeholder parity by base key (plural-variant agnostic).
      for (const [key, enValue] of enFlat) {
        if (typeof enValue !== 'string') continue
        const otherValue = otherFlat.get(key)
        if (otherValue !== undefined) {
          expect(placeholders(otherValue), `${locale}/${key}`).toEqual(placeholders(enValue))
        }
      }
      // Base-key set parity (plural suffixes may differ per language).
      expect(baseKeys(other)).toEqual(baseKeys(en))
    })
  }
})
