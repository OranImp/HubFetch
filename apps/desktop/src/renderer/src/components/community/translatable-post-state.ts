import {
  SUPPORTED_LOCALES,
  type Locale,
  type LlmErrorCode,
  type LlmTranslateResult
} from '@hubfetch/shared'

export type TranslationPane = 'original' | 'translated'

export type TranslateView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly requestId: string }
  | {
      readonly kind: 'translated'
      readonly markdown: string
      readonly showing: TranslationPane
    }
  | { readonly kind: 'same-language' }
  | { readonly kind: 'error'; readonly error: LlmErrorCode }

export const IDLE_VIEW: TranslateView = { kind: 'idle' }

export function translationLocale(locale: string): Locale {
  for (const supported of SUPPORTED_LOCALES) {
    if (supported === locale) return supported
  }
  return 'en'
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${String(value)}`)
}

export function viewFromResult(result: LlmTranslateResult): TranslateView {
  switch (result.status) {
    case 'translated':
      return { kind: 'translated', markdown: result.markdown, showing: 'translated' }
    case 'same-language':
      return { kind: 'same-language' }
    case 'error':
      return result.error === 'canceled' ? IDLE_VIEW : { kind: 'error', error: result.error }
    default:
      return assertNever(result)
  }
}

export function displayedMarkdown(view: TranslateView, original: string): string {
  if (view.kind === 'translated' && view.showing === 'translated') return view.markdown
  return original
}
