import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * i18n guard: every locale must ship the exact same key set as English.
 * A missing or extra key in any namespace fails CI.
 */
const localesDir = join(__dirname, 'locales')

function flatEntries(obj: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  return Object.entries(obj).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null
      ? flatEntries(value as Record<string, unknown>, `${prefix}${key}.`)
      : [[`${prefix}${key}`, value] as [string, unknown]]
  )
}

/** Plural suffixes differ per language (en has _one, zh-CN does not); compare base keys. */
function baseKeys(obj: Record<string, unknown>): string[] {
  return [
    ...new Set(flatEntries(obj).map(([key]) => key.replace(/_(zero|one|two|few|many|other)$/, '')))
  ].sort()
}

/** Extract the set of `{{interpolation}}` placeholders used by a value. */
function placeholders(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort()
}

/**
 * Values that are legitimately shared verbatim across every locale: brand,
 * protocol, technical tokens, format labels, and proper nouns. These are NOT
 * "untranslated prose" and must not trip the no-machine-copy guard.
 */
const TECHNICAL_ALLOWLIST = new Set([
  'User Access Token',
  'Revision (optional)',
  'System (GCM / SSH)',
  'Português (Brasil)',
  'Pull Requests',
  'Pull request',
  'Daily Papers',
  'Enterprise Plus',
  'Git Credential Manager',
  '> 1T',
  '< 1K',
  '> 30B',
  '< 1B',
  '> 100B',
  '< 10B',
  'My awesome collection'
])

/**
 * A value is "untranslated prose" when it is identical to the English source,
 * contains at least one lowercase letter (so it is translatable prose, not a
 * bare acronym/placeholder/format token), contains whitespace, and is not on
 * the technical allowlist. Brand/technical identifiers and format labels stay
 * identical legitimately; real prose must not be machine-copied.
 */
function isUntranslatedProse(value: string): boolean {
  if (TECHNICAL_ALLOWLIST.has(value)) return false
  if (value.includes('{{') || value.includes('}}')) return false
  return /\s/.test(value) && /[a-z]/.test(value)
}

describe('locale completeness', () => {
  const locales = readdirSync(localesDir)
  const namespaces = readdirSync(join(localesDir, 'en'))

  it('ships en and zh-CN', () => {
    expect(locales).toContain('en')
    expect(locales).toContain('zh-CN')
  })

  for (const locale of locales) {
    for (const ns of namespaces) {
      it(`${locale}/${ns} has no empty strings`, () => {
        const data = JSON.parse(readFileSync(join(localesDir, locale, ns), 'utf8'))
        for (const [key, value] of flatEntries(data)) {
          expect(typeof value, key).toBe('string')
          expect(value, key).not.toBe('')
        }
      })
    }
  }

  for (const locale of locales.filter((l) => l !== 'en')) {
    for (const ns of namespaces) {
      it(`${locale}/${ns} mirrors en/${ns}`, () => {
        const en = JSON.parse(readFileSync(join(localesDir, 'en', ns), 'utf8'))
        const other = JSON.parse(readFileSync(join(localesDir, locale, ns), 'utf8'))
        expect(baseKeys(other)).toEqual(baseKeys(en))
      })

      it(`${locale}/${ns} keeps identical interpolation placeholders`, () => {
        const en = JSON.parse(readFileSync(join(localesDir, 'en', ns), 'utf8'))
        const other = JSON.parse(readFileSync(join(localesDir, locale, ns), 'utf8'))

        // Group placeholders by BASE key: i18next resolves one plural variant per
        // locale (en uses _one/_other, ja/ko/zh only _other), so the interpolation
        // contract is that every base key uses the same variables regardless of
        // which variant a language renders.
        function placeholdersByBase(obj: Record<string, unknown>): Map<string, string[]> {
          const byBase = new Map<string, Set<string>>()
          for (const [key, value] of flatEntries(obj)) {
            if (typeof value !== 'string') continue
            const base = key.replace(/_(zero|one|two|few|many|other)$/, '')
            const set = byBase.get(base) ?? new Set<string>()
            for (const p of placeholders(value)) set.add(p)
            byBase.set(base, set)
          }
          return new Map([...byBase].map(([k, s]) => [k, [...s].sort()]))
        }

        const enBase = placeholdersByBase(en)
        const otherBase = placeholdersByBase(other)
        expect([...otherBase.keys()].sort()).toEqual([...enBase.keys()].sort())
        for (const [base, enPlaceholders] of enBase) {
          expect(otherBase.get(base), `${locale}/${ns}/${base}`).toEqual(enPlaceholders)
        }
      })

      it(`${locale}/${ns} has no machine-copied untranslated prose`, () => {
        const en = JSON.parse(readFileSync(join(localesDir, 'en', ns), 'utf8'))
        const other = JSON.parse(readFileSync(join(localesDir, locale, ns), 'utf8'))
        const enFlat = new Map(flatEntries(en))
        const otherFlat = new Map(flatEntries(other))
        for (const [key, enValue] of enFlat) {
          if (typeof enValue !== 'string') continue
          const otherValue = otherFlat.get(key)
          if (otherValue === enValue && isUntranslatedProse(enValue)) {
            expect.fail(`${locale}/${ns}/${key} is untranslated English prose: "${enValue}"`)
          }
        }
      })
    }
  }
})
