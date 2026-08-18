import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Hardcoded-visible-string lint for the native menu/tray surfaces (Todo 40).
 *
 * The renderer enforces `i18next/no-literal-string` via ESLint; the main-process
 * menu and tray are plain TS (not covered by the JSX-only rule), so this test
 * statically guards the same contract: every visible menu/tray label must come
 * from the i18n catalog (a `t(...)` / `i18n.t(...)` call), never a literal string.
 */
const root = join(__dirname, '..')

describe('native menu/tray hardcoded-string lint', () => {
  const files = ['menu.ts', 'tray.ts']

  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8')
    const lines = source.split('\n')

    it(`${file} has no hardcoded visible label literals`, () => {
      // A `label:` whose value is a quoted string literal means a visible string
      // bypassed the i18n catalog. `t(...)`, dynamic expressions, and roles are fine.
      const offenders = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /label:\s*['"]/.test(line))
        .map(({ line, i }) => `${file}:${i + 1}: ${line.trim()}`)
      expect(offenders, `hardcoded label literals in ${file}`).toEqual([])
    })

    it(`${file} routes its tooltip through i18n`, () => {
      // Tray tooltip (the only visible tooltip on these surfaces) must be translated.
      const offenders = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /setToolTip\(/.test(line) && !/\.t\(/.test(line))
        .map(({ line, i }) => `${file}:${i + 1}: ${line.trim()}`)
      expect(offenders, `untranslated tooltip in ${file}`).toEqual([])
    })
  }
})
