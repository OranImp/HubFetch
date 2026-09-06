import { describe, expect, it } from 'vitest'
import type { LlmTranslateResult } from '@hubfetch/shared'
import {
  displayedMarkdown,
  IDLE_VIEW,
  translationLocale,
  viewFromResult
} from './translatable-post-state'

describe('translationLocale', () => {
  it('keeps a supported locale and falls back to English otherwise', () => {
    expect(translationLocale('zh-CN')).toBe('zh-CN')
    expect(translationLocale('pt-BR')).toBe('pt-BR')
    expect(translationLocale('system')).toBe('en')
  })
})

describe('viewFromResult', () => {
  it('maps translated, same-language, typed error, and canceled results', () => {
    expect(
      viewFromResult({
        status: 'translated',
        sourceLanguage: 'en',
        markdown: 'hola'
      } satisfies LlmTranslateResult)
    ).toEqual({ kind: 'translated', markdown: 'hola', showing: 'translated' })
    expect(
      viewFromResult({ status: 'same-language', sourceLanguage: 'en' } satisfies LlmTranslateResult)
    ).toEqual({ kind: 'same-language' })
    expect(
      viewFromResult({ status: 'error', error: 'rate-limited' } satisfies LlmTranslateResult)
    ).toEqual({ kind: 'error', error: 'rate-limited' })
    expect(viewFromResult({ status: 'error', error: 'canceled' } satisfies LlmTranslateResult)).toBe(
      IDLE_VIEW
    )
  })
})

describe('displayedMarkdown', () => {
  it('shows translated markdown only while the translated pane is selected', () => {
    const original = 'hello'
    expect(displayedMarkdown(IDLE_VIEW, original)).toBe(original)
    expect(
      displayedMarkdown({ kind: 'translated', markdown: 'hola', showing: 'translated' }, original)
    ).toBe('hola')
    expect(
      displayedMarkdown({ kind: 'translated', markdown: 'hola', showing: 'original' }, original)
    ).toBe(original)
  })
})
