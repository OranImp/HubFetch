import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Todo 43 packaged axe scan flagged 9 serious `color-contrast` nodes on
 * Diagnostics: the success Badge uses `text-success` on `bg-success/10`,
 * which is green-on-pale-green and fails WCAG AA (~3:1). Warning already
 * uses ink text on a tinted wash. Success must do the same — status is
 * never color-only (DESIGN.md).
 */
describe('Badge success contrast', () => {
  it('success variant uses ink text on the success wash, not text-success', () => {
    const src = readFileSync(join(__dirname, 'badge.tsx'), 'utf8')
    const match = src.match(/success:\s*'([^']+)'/)
    expect(match, 'success variant missing from badge.tsx').toBeTruthy()
    const classes = match?.[1] ?? ''
    expect(classes).toMatch(/\btext-ink(-strong)?\b/)
    expect(classes).not.toMatch(/\btext-success\b/)
  })
})
