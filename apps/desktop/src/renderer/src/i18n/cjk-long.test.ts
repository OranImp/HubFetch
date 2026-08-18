import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import i18next from 'i18next'
import { describe, expect, it } from 'vitest'
import { NAMESPACES, initI18n } from './index'

/**
 * CJK / Unicode long-string coverage (Todo 40).
 *
 * Long Simplified-Chinese strings are the highest-risk surface for missing-key
 * fallback and CJK clipping. This fixture drives the longest zh-CN value in every
 * namespace through i18next and asserts it resolves (no raw-key fallback), is
 * non-empty, and stays CJK — a deterministic guard for long-text localization.
 */
const localesDir = join(__dirname, 'locales')

function flatEntries(obj: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  return Object.entries(obj).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null
      ? flatEntries(value as Record<string, unknown>, `${prefix}${key}.`)
      : [[`${prefix}${key}`, value] as [string, unknown]]
  )
}

describe('CJK / Unicode long-string coverage', () => {
  it('zh-CN longest strings resolve without missing-key fallback', async () => {
    await initI18n('zh-CN')
    for (const ns of NAMESPACES) {
      const data = JSON.parse(readFileSync(join(localesDir, 'zh-CN', `${ns}.json`), 'utf8'))
      const entries = flatEntries(data).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
      if (entries.length === 0) continue
      const longest = entries.sort((a, b) => b[1].length - a[1].length)[0]
      if (!longest) continue
      const [key, value] = longest
      // Ensure the fixture is actually long enough to be meaningful.
      expect(value.length, `${ns}/${key} fixture too short`).toBeGreaterThan(10)
      const resolved = i18next.t(`${ns}:${key}`)
      expect(resolved, `${ns}/${key} fell back to the raw key`).not.toBe(`${ns}:${key}`)
      expect(resolved, `${ns}/${key} resolved empty`).not.toBe('')
      expect(/[\u4e00-\u9fff]/.test(resolved), `${ns}/${key} not CJK: "${resolved}"`).toBe(true)
    }
  })
})
