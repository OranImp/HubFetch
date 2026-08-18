import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_LOCALES } from '@hubfetch/shared'

/**
 * Exact missing-and-extra catalog assertion (Todo 40 acceptance).
 *
 * Both the renderer catalog set and the main catalog set must equal EXACTLY the
 * nine supported locales — no extra language directory and no missing one.
 * This is a strict set equality (not "contains"), so a stray locale or a dropped
 * language fails CI with an exact diff.
 */
const rendererLocalesDir = join(__dirname, 'locales')
// __dirname = <root>/apps/desktop/src/renderer/src/i18n
const mainLocalesDir = join(__dirname, '..', '..', '..', 'main', 'i18n', 'locales')

const NINE_LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-CN', 'zh-TW']

function sorted(entries: string[]): string[] {
  return [...entries].sort()
}

describe('exact locale catalog set', () => {
  it('renderer catalog directory equals exactly the nine supported locales', () => {
    const onDisk = readdirSync(rendererLocalesDir).filter((name) => !name.startsWith('.'))
    expect(sorted(onDisk)).toEqual(sorted(NINE_LOCALES))
  })

  it('main catalog directory equals exactly the nine supported locales', () => {
    const onDisk = readdirSync(mainLocalesDir).filter((name) => name.endsWith('.json'))
    const names = onDisk.map((name) => name.replace(/\.json$/, ''))
    expect(sorted(names)).toEqual(sorted(NINE_LOCALES))
  })

  it('SUPPORTED_LOCALES equals exactly the nine supported locales', () => {
    expect(sorted([...SUPPORTED_LOCALES])).toEqual(sorted(NINE_LOCALES))
  })

  it('renderer and main catalog sets are identical to each other', () => {
    const renderer = readdirSync(rendererLocalesDir).filter((n) => !n.startsWith('.'))
    const main = readdirSync(mainLocalesDir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.replace(/\.json$/, ''))
    expect(sorted(renderer)).toEqual(sorted(main))
  })
})
